/**
 * Tesla Dashcam Module — Standalone & Modular
 * Parses Tesla front camera MP4 SEI metadata (GPS, speed, gear, steering, etc.)
 * and displays vehicle on map with synchronized video + driving dashboard.
 *
 * Dependencies: protobuf.min.js (vendor), MapLibre GL JS (global window.map)
 * No modifications to vehicle-animation.js required.
 */

// Fallback if Logger is not available
if (typeof Logger === 'undefined') { window.Logger = { log: function() { console.log.apply(console, arguments); } }; }

const TeslaDashcam = {

  // ── State ──────────────────────────────────────────────
  map: null,
  SeiMetadata: null,
  activeSessions: {},   // sessionId → { metadata[], videoUrl, fileName, coord, bearing }
  activePopups: {},     // sessionId → { popup, syncRAF }
  sessionCounter: 0,
  layerReady: false,
  isMobile: window.innerWidth <= 768,

  // ── Init ───────────────────────────────────────────────
  init: function(map) {
    this.map = map;
    this._initProtobuf();
    this._addMapLayer();
    // Click handler is set up after layer is created (in _createSourceAndLayer)
    Logger.log('[TeslaDashcam] Module initialized');
  },

  // ── Protobuf Schema (inline reflection API) ───────────
  _initProtobuf: function() {
    if (typeof protobuf === 'undefined') {
      Logger.log('[TeslaDashcam] protobuf.js not loaded, SEI parsing disabled');
      return;
    }

    var Root = protobuf.Root;
    var Type = protobuf.Type;
    var Field = protobuf.Field;
    var Enum = protobuf.Enum;

    var root = new Root();

    var GearState = new Enum('GearState', {
      GEAR_PARK: 0,
      GEAR_DRIVE: 1,
      GEAR_REVERSE: 2,
      GEAR_NEUTRAL: 3
    });

    var AutopilotState = new Enum('AutopilotState', {
      AP_NONE: 0,
      AP_SELF_DRIVING: 1,
      AP_AUTOSTEER: 2,
      AP_TACC: 3
    });

    var SeiMetadata = new Type('SeiMetadata')
      .add(GearState)
      .add(AutopilotState)
      .add(new Field('version', 1, 'uint32'))
      .add(new Field('gearState', 2, 'GearState'))
      .add(new Field('frameSeqNo', 3, 'uint64'))
      .add(new Field('vehicleSpeedMps', 4, 'float'))
      .add(new Field('acceleratorPedalPosition', 5, 'float'))
      .add(new Field('steeringWheelAngle', 6, 'float'))
      .add(new Field('blinkerOnLeft', 7, 'bool'))
      .add(new Field('blinkerOnRight', 8, 'bool'))
      .add(new Field('brakeApplied', 9, 'bool'))
      .add(new Field('autopilotState', 10, 'AutopilotState'))
      .add(new Field('latitudeDeg', 11, 'double'))
      .add(new Field('longitudeDeg', 12, 'double'))
      .add(new Field('headingDeg', 13, 'double'))
      .add(new Field('linearAccelerationMps2X', 14, 'double'))
      .add(new Field('linearAccelerationMps2Y', 15, 'double'))
      .add(new Field('linearAccelerationMps2Z', 16, 'double'));

    root.add(SeiMetadata);
    this.SeiMetadata = root.lookupType('SeiMetadata');
    Logger.log('[TeslaDashcam] Protobuf schema ready');
  },

  // ══════════════════════════════════════════════════════
  //  MP4 SEI PARSER
  // ══════════════════════════════════════════════════════

  /**
   * Parse a Tesla dashcam MP4 buffer and extract SEI metadata with timestamps.
   * Returns: Array of { time (seconds), lat, lng, heading, speed, gear, ... }
   */
  parseMP4: function(buffer) {
    var view = new DataView(buffer);
    var self = this;

    // ── Box Navigation ──
    function readAscii(offset, len) {
      var s = '';
      for (var i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
      return s;
    }

    function findBox(start, end, name) {
      for (var pos = start; pos + 8 <= end;) {
        var size = view.getUint32(pos);
        var type = readAscii(pos + 4, 4);
        var headerSize = 8;

        if (size === 1) {
          // 64-bit extended size
          var high = view.getUint32(pos + 8);
          var low = view.getUint32(pos + 12);
          size = high * 0x100000000 + low;
          headerSize = 16;
        } else if (size === 0) {
          size = end - pos;
        }

        if (size < 8) break; // invalid

        if (type === name) {
          return { start: pos + headerSize, end: pos + size, size: size - headerSize };
        }
        pos += size;
      }
      return null;
    }

    function findBoxRequired(start, end, name) {
      var box = findBox(start, end, name);
      if (!box) throw new Error('Box "' + name + '" not found');
      return box;
    }

    // ── Find Video Track ──
    // Tesla MP4s may have multiple tracks. We need the video track (handler_type = 'vide').
    function findVideoTrack(moov) {
      for (var pos = moov.start; pos + 8 <= moov.end;) {
        var size = view.getUint32(pos);
        var type = readAscii(pos + 4, 4);
        var headerSize = 8;
        if (size === 1) {
          var h = view.getUint32(pos + 8);
          var l = view.getUint32(pos + 12);
          size = h * 0x100000000 + l;
          headerSize = 16;
        } else if (size === 0) {
          size = moov.end - pos;
        }
        if (size < 8) break;

        if (type === 'trak') {
          var trakBox = { start: pos + headerSize, end: pos + size };
          var mdia = findBox(trakBox.start, trakBox.end, 'mdia');
          if (mdia) {
            var hdlr = findBox(mdia.start, mdia.end, 'hdlr');
            if (hdlr) {
              var handlerType = readAscii(hdlr.start + 8, 4);
              if (handlerType === 'vide') return trakBox;
            }
          }
        }
        pos += size;
      }
      return null;
    }

    try {
      var moov = findBoxRequired(0, buffer.byteLength, 'moov');
      var trak = findVideoTrack(moov);
      if (!trak) throw new Error('Video track not found');

      var mdia = findBoxRequired(trak.start, trak.end, 'mdia');

      // ── Timescale from mdhd ──
      var mdhd = findBoxRequired(mdia.start, mdia.end, 'mdhd');
      var mdhdVersion = view.getUint8(mdhd.start);
      var timescale;
      if (mdhdVersion === 1) {
        timescale = view.getUint32(mdhd.start + 20);
      } else {
        timescale = view.getUint32(mdhd.start + 12);
      }

      // ── Sample Table ──
      var minf = findBoxRequired(mdia.start, mdia.end, 'minf');
      var stbl = findBoxRequired(minf.start, minf.end, 'stbl');

      // stts → frame durations
      var stts = findBoxRequired(stbl.start, stbl.end, 'stts');
      var sttsEntryCount = view.getUint32(stts.start + 4);
      var durations = [];
      var sttsPos = stts.start + 8;
      for (var i = 0; i < sttsEntryCount; i++) {
        var count = view.getUint32(sttsPos);
        var delta = view.getUint32(sttsPos + 4);
        var ms = (delta / timescale) * 1000;
        for (var j = 0; j < count; j++) durations.push(ms);
        sttsPos += 8;
      }

      // ── Find mdat ──
      var mdat = findBoxRequired(0, buffer.byteLength, 'mdat');

      // ── Walk NAL units in mdat, extract SEI + timestamps ──
      var metadata = [];
      var cursor = mdat.start;
      var end = mdat.end;
      var frameIndex = 0;
      var currentTimeMs = 0;

      while (cursor + 4 <= end) {
        var nalSize = view.getUint32(cursor);
        cursor += 4;

        if (nalSize < 1 || cursor + nalSize > buffer.byteLength) break;

        var naluType = view.getUint8(cursor) & 0x1F;

        if (naluType === 6) {
          // SEI NAL unit
          var nalData = new Uint8Array(buffer.slice(cursor, cursor + nalSize));
          var decoded = self._decodeSEI(nalData);
          if (decoded) {
            decoded._time = currentTimeMs / 1000;
            metadata.push(decoded);
          }
        } else if (naluType === 1 || naluType === 5) {
          // Coded slice (non-IDR or IDR) → advance timestamp
          if (frameIndex < durations.length) {
            currentTimeMs += durations[frameIndex];
          }
          frameIndex++;
        }

        cursor += nalSize;
      }

      Logger.log('[TeslaDashcam] Parsed', metadata.length, 'SEI frames from', frameIndex, 'video frames');
      return metadata;

    } catch (err) {
      Logger.log('[TeslaDashcam] Parse error:', err.message);
      return [];
    }
  },

  // ── SEI Decode ─────────────────────────────────────────
  _decodeSEI: function(nal) {
    if (!this.SeiMetadata || nal.length < 4) return null;

    // Tesla SEI format: after NAL header, payload type 5 (user_data_unregistered)
    // Check for payload type 5 marker
    if (nal[1] === 5) {
      // Skip payload type byte + size bytes to find Tesla marker pattern
      // Tesla uses 0x42 bytes followed by 0x69 as a marker
      var i = 3;
      while (i < nal.length && nal[i] === 0x42) i++;
      if (i <= 3 || i + 1 >= nal.length || nal[i] !== 0x69) return null;

      try {
        var stripped = this._stripEmulationBytes(nal.subarray(i + 1, nal.length - 1));
        var decoded = this.SeiMetadata.decode(stripped);
        return this.SeiMetadata.toObject(decoded, { longs: Number, defaults: true });
      } catch (e) {
        return null;
      }
    }

    return null;
  },

  _stripEmulationBytes: function(data) {
    var out = [];
    var zeros = 0;
    for (var k = 0; k < data.length; k++) {
      var byte = data[k];
      if (zeros >= 2 && byte === 0x03) {
        zeros = 0;
        continue;
      }
      out.push(byte);
      zeros = (byte === 0) ? zeros + 1 : 0;
    }
    return Uint8Array.from(out);
  },

  // ══════════════════════════════════════════════════════
  //  SESSION MANAGEMENT
  // ══════════════════════════════════════════════════════

  createSession: function(file, onProgress) {
    var self = this;
    var sessionId = 'tesla-' + (++this.sessionCounter);

    if (onProgress) onProgress('Dosya okunuyor...');

    var reader = new FileReader();
    reader.onload = function(e) {
      if (onProgress) onProgress('SEI metadata parse ediliyor...');

      var buffer = e.target.result;
      var metadata = self.parseMP4(buffer);

      if (!metadata || metadata.length === 0) {
        if (onProgress) onProgress('HATA: Bu dosyadan metadata okunamadi');
        if (window.showNotification) showNotification('Bu dosyadan SEI metadata okunamadi', 'error');
        return;
      }

      // Filter entries with valid GPS
      var gpsMetadata = metadata.filter(function(m) {
        return m.latitudeDeg && m.longitudeDeg &&
               m.latitudeDeg !== 0 && m.longitudeDeg !== 0;
      });

      if (gpsMetadata.length === 0) {
        // Still usable without GPS — just no map movement
        Logger.log('[TeslaDashcam] No GPS data found, using all metadata without map animation');
        gpsMetadata = metadata;
      }

      var videoUrl = URL.createObjectURL(file);

      var session = {
        id: sessionId,
        metadata: metadata,
        gpsMetadata: gpsMetadata,
        videoUrl: videoUrl,
        fileName: file.name,
        hasGPS: gpsMetadata[0] && gpsMetadata[0].latitudeDeg !== 0,
        coord: gpsMetadata[0] && gpsMetadata[0].latitudeDeg !== 0
          ? [gpsMetadata[0].longitudeDeg, gpsMetadata[0].latitudeDeg]
          : null,
        bearing: gpsMetadata[0] ? (gpsMetadata[0].headingDeg || 0) : 0
      };

      self.activeSessions[sessionId] = session;

      // Add to map
      if (session.hasGPS) {
        self._addTrailLayer(sessionId, gpsMetadata);
        self._updateMapSource();

        // Fly to start position
        self.map.flyTo({
          center: session.coord,
          zoom: 16,
          duration: 1500
        });
      }

      if (onProgress) onProgress('OK');
      if (window.showNotification) {
        showNotification(
          gpsMetadata.length + ' metadata noktasi yuklendi' +
          (session.hasGPS ? '' : ' (GPS verisi yok)'),
          'success'
        );
      }

      Logger.log('[TeslaDashcam] Session created:', sessionId, '- GPS points:', gpsMetadata.length);
    };

    reader.onerror = function() {
      if (onProgress) onProgress('HATA: Dosya okunamadi');
      if (window.showNotification) showNotification('Dosya okunamadi', 'error');
    };

    reader.readAsArrayBuffer(file);
    return sessionId;
  },

  destroySession: function(sessionId) {
    var session = this.activeSessions[sessionId];
    if (!session) return;

    // Close popup
    this.closePopup(sessionId);

    // Revoke blob URL
    if (session.videoUrl) URL.revokeObjectURL(session.videoUrl);

    // Remove trail layer
    this._removeTrailLayer(sessionId);

    delete this.activeSessions[sessionId];
    this._updateMapSource();

    Logger.log('[TeslaDashcam] Session destroyed:', sessionId);
  },

  // ── Metadata Lookup (binary search) ───────────────────
  getMetadataAtTime: function(sessionId, time) {
    var session = this.activeSessions[sessionId];
    if (!session || !session.metadata.length) return null;

    var meta = session.metadata;
    var low = 0;
    var high = meta.length - 1;

    // Binary search for closest timestamp
    while (low < high) {
      var mid = (low + high) >> 1;
      if (meta[mid]._time < time) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // Compare with previous entry to find closest
    if (low > 0 && Math.abs(meta[low - 1]._time - time) < Math.abs(meta[low]._time - time)) {
      return meta[low - 1];
    }
    return meta[low];
  },

  // ══════════════════════════════════════════════════════
  //  MAPLIBRE LAYER (independent from vehicles layer)
  // ══════════════════════════════════════════════════════

  _addMapLayer: function() {
    var self = this;

    // Load Tesla icon (use a car icon with red tint, or just reuse car.png)
    var img = new Image();
    img.onload = function() {
      if (!self.map.hasImage('tesla-vehicle-icon')) {
        self.map.addImage('tesla-vehicle-icon', img);
      }
      self._createSourceAndLayer();
    };
    img.onerror = function() {
      // Fallback: create source/layer anyway, icon might already exist
      self._createSourceAndLayer();
    };
    img.src = '/car.png'; // Reuse existing car icon for now
  },

  _createSourceAndLayer: function() {
    if (this.map.getSource('tesla-vehicles')) return;

    this.map.addSource('tesla-vehicles', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    this.map.addLayer({
      id: 'tesla-vehicles',
      type: 'symbol',
      source: 'tesla-vehicles',
      minzoom: 3,
      maxzoom: 20,
      layout: {
        'icon-image': 'tesla-vehicle-icon',
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          10, 0.15,
          14, 0.25,
          17, 0.5
        ],
        'icon-allow-overlap': true,
        'icon-rotate': ['-', ['get', 'bearing'], 90],
        'icon-rotation-alignment': 'map'
      }
    });

    this.layerReady = true;
    this._setupClickHandler();
    Logger.log('[TeslaDashcam] Map layer ready');
  },

  _updateMapSource: function() {
    var source = this.map.getSource('tesla-vehicles');
    if (!source) return;

    var features = [];
    var self = this;
    Object.keys(this.activeSessions).forEach(function(sid) {
      var session = self.activeSessions[sid];
      if (session.coord) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: session.coord },
          properties: {
            id: sid,
            bearing: session.bearing || 0,
            fileName: session.fileName
          }
        });
      }
    });

    source.setData({ type: 'FeatureCollection', features: features });
  },

  _addTrailLayer: function(sessionId, gpsMetadata) {
    var coords = [];
    for (var i = 0; i < gpsMetadata.length; i++) {
      var m = gpsMetadata[i];
      if (m.latitudeDeg && m.longitudeDeg && m.latitudeDeg !== 0 && m.longitudeDeg !== 0) {
        coords.push([m.longitudeDeg, m.latitudeDeg]);
      }
    }

    if (coords.length < 2) return;

    var sourceId = 'tesla-trail-' + sessionId;
    var layerId = 'tesla-trail-' + sessionId;

    this.map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords }
      }
    });

    this.map.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': '#e74c3c',
        'line-width': 3,
        'line-dasharray': [2, 2],
        'line-opacity': 0.7
      }
    });
  },

  _removeTrailLayer: function(sessionId) {
    var layerId = 'tesla-trail-' + sessionId;
    var sourceId = 'tesla-trail-' + sessionId;
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  },

  // ── Click Handler ──────────────────────────────────────
  _setupClickHandler: function() {
    var self = this;

    this.map.on('click', 'tesla-vehicles', function(e) {
      if (e.features && e.features.length > 0) {
        var sessionId = e.features[0].properties.id;
        self.togglePopup(sessionId);
      }
    });

    this.map.on('mouseenter', 'tesla-vehicles', function() {
      self.map.getCanvas().style.cursor = 'pointer';
    });

    this.map.on('mouseleave', 'tesla-vehicles', function() {
      self.map.getCanvas().style.cursor = '';
    });
  },

  // ══════════════════════════════════════════════════════
  //  POPUP + DASHBOARD
  // ══════════════════════════════════════════════════════

  togglePopup: function(sessionId) {
    if (this.activePopups[sessionId]) {
      this.closePopup(sessionId);
    } else {
      this.showPopup(sessionId);
    }
  },

  showPopup: function(sessionId) {
    var session = this.activeSessions[sessionId];
    if (!session) return;

    // Close existing popup for this session
    if (this.activePopups[sessionId]) this.closePopup(sessionId);

    var popup = this._createPopupElement(sessionId, session);
    document.body.appendChild(popup);

    var video = popup.querySelector('.tesla-video');
    video.src = session.videoUrl;

    // Wait for video metadata to set up scrubber
    var scrubber = popup.querySelector('.tesla-scrubber');
    video.addEventListener('loadedmetadata', function() {
      scrubber.max = video.duration;
    });

    // Scrubber seek
    scrubber.addEventListener('input', function() {
      video.currentTime = parseFloat(scrubber.value);
    });

    // Play/pause on video click
    video.addEventListener('click', function() {
      if (video.paused) video.play(); else video.pause();
    });

    this.activePopups[sessionId] = {
      popup: popup,
      syncRAF: null,
      video: video
    };

    // Show with animation
    requestAnimationFrame(function() { popup.classList.add('active'); });

    // Update position immediately
    this._updatePopupPosition(sessionId);

    // Start sync loop
    this._startSyncLoop(sessionId);

    // Auto-play
    video.play().catch(function() {});
  },

  closePopup: function(sessionId) {
    var popupData = this.activePopups[sessionId];
    if (!popupData) return;

    // Stop sync loop
    if (popupData.syncRAF) cancelAnimationFrame(popupData.syncRAF);

    // Stop video
    var video = popupData.video;
    if (video) {
      video.pause();
      video.src = '';
    }

    // Remove DOM
    var popup = popupData.popup;
    popup.classList.remove('active');
    setTimeout(function() {
      if (popup.parentNode) popup.parentNode.removeChild(popup);
    }, 300);

    delete this.activePopups[sessionId];
  },

  _createPopupElement: function(sessionId, session) {
    var self = this;
    var popup = document.createElement('div');
    popup.id = 'tesla-popup-' + sessionId;
    popup.className = 'tesla-popup';

    // SVG Icons — exact Tesla / TDashcamStudio originals
    var steeringSVG = '<svg class="meta-steering-icon" viewBox="0 0 64 64" width="18" height="18">' +
      '<circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="5"/>' +
      '<circle cx="32" cy="32" r="9" fill="rgba(255,255,255,0.9)"/>' +
      '<rect x="4" y="28" width="19" height="8" rx="2" fill="rgba(255,255,255,0.9)"/>' +
      '<rect x="41" y="28" width="19" height="8" rx="2" fill="rgba(255,255,255,0.9)"/>' +
      '<rect x="28" y="41" width="8" height="19" rx="2" fill="rgba(255,255,255,0.9)"/>' +
    '</svg>';

    var brakeSVG = '<svg class="meta-brake-icon" viewBox="0 0 1024 1024" width="22" height="22">' +
      '<g class="brake-inactive"><path d="M821.394 861.482H200.242c-23.709 0-44.013-20.191-45.124-44.975 0 0-30.555-129.896-30.044-166.228 0.325-23.102 15.23-164.3 15.23-164.3 2.449-27.739 18.019-48.258 42.686-48.258h646.233c24.667 0 44.357 21.769 43.759 48.258l14.579 163.622-22.043 166.906c-0.56 24.784-20.414 44.975-44.124 44.975z m24.716-358.364l0.292-10.498c0.23-8.275-6.452-15.059-14.85-15.059H186.497c-8.397 0-14.828 6.784-14.291 15.059l0.681 10.498c0.534 8.232 7.802 14.954 16.153 14.954h641.472c8.35 0 15.37-6.722 15.598-14.954z m8.739 81.304l0.296-10.264c0.233-8.091-6.628-14.724-15.248-14.724H177.735c-8.62 0-15.226 6.633-14.681 14.724l0.691 10.264c0.542 8.049 7.999 14.622 16.571 14.622H838.84c8.574 0 15.777-6.572 16.009-14.622z m6.172 79.506l0.298-10.038c0.235-7.912-6.747-14.399-15.516-14.399H172.234c-8.769 0-15.494 6.487-14.945 14.399l0.695 10.038c0.545 7.872 8.126 14.3 16.847 14.3h669.91c8.721 0 16.047-6.428 16.28-14.3z m-14.901 77.765l0.282-9.819c0.222-7.74-6.466-14.085-14.863-14.085H186.526c-8.397 0-14.841 6.345-14.322 14.085l0.659 9.819c0.517 7.701 7.772 13.989 16.123 13.989h641.548c8.351 0 15.365-6.288 15.586-13.989z m-8.749 76.081l0.267-9.608c0.21-7.573-6.189-13.781-14.222-13.781H206.385c-8.033 0-14.202 6.208-13.711 13.781l0.623 9.608c0.489 7.535 7.425 13.688 15.415 13.688h613.751c7.99 0.001 14.698-6.152 14.908-13.688z m1.869-378.856l36.038-94.167 21.623-119.775H785.183L752.749 356.56l-118.926 82.358H839.24z" fill="rgba(255,255,255,0.3)"/></g>' +
      '<g class="brake-active"><path d="M821.394 861.482H200.242c-23.709 0-44.013-20.191-45.124-44.975 0 0-30.555-129.896-30.044-166.228 0.325-23.102 15.23-164.3 15.23-164.3 2.449-27.739 18.019-48.258 42.686-48.258h646.233c24.667 0 44.357 21.769 43.759 48.258l14.579 163.622-22.043 166.906c-0.56 24.784-20.414 44.975-44.124 44.975z m24.716-358.364l0.292-10.498c0.23-8.275-6.452-15.059-14.85-15.059H186.497c-8.397 0-14.828 6.784-14.291 15.059l0.681 10.498c0.534 8.232 7.802 14.954 16.153 14.954h641.472c8.35 0 15.37-6.722 15.598-14.954z m8.739 81.304l0.296-10.264c0.233-8.091-6.628-14.724-15.248-14.724H177.735c-8.62 0-15.226 6.633-14.681 14.724l0.691 10.264c0.542 8.049 7.999 14.622 16.571 14.622H838.84c8.574 0 15.777-6.572 16.009-14.622z m6.172 79.506l0.298-10.038c0.235-7.912-6.747-14.399-15.516-14.399H172.234c-8.769 0-15.494 6.487-14.945 14.399l0.695 10.038c0.545 7.872 8.126 14.3 16.847 14.3h669.91c8.721 0 16.047-6.428 16.28-14.3z m-14.901 77.765l0.282-9.819c0.222-7.74-6.466-14.085-14.863-14.085H186.526c-8.397 0-14.841 6.345-14.322 14.085l0.659 9.819c0.517 7.701 7.772 13.989 16.123 13.989h641.548c8.351 0 15.365-6.288 15.586-13.989z m-8.749 76.081l0.267-9.608c0.21-7.573-6.189-13.781-14.222-13.781H206.385c-8.033 0-14.202 6.208-13.711 13.781l0.623 9.608c0.489 7.535 7.425 13.688 15.415 13.688h613.751c7.99 0.001 14.698-6.152 14.908-13.688z m1.869-378.856l36.038-94.167 21.623-119.775H785.183L752.749 356.56l-118.926 82.358H839.24z" fill="#ff4d4f"/></g>' +
    '</svg>';

    var blinkerLeftSVG = '<svg viewBox="0 0 48 48" width="18" height="18">' +
      '<path class="blinker-outline" d="M20 8 L6 24 L20 40 L20 30 L42 30 L42 18 L20 18 Z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<path class="blinker-fill" d="M20 8 L6 24 L20 40 L20 30 L42 30 L42 18 L20 18 Z" fill="#f59e0b" stroke="none" opacity="0"/>' +
    '</svg>';

    var blinkerRightSVG = '<svg viewBox="0 0 48 48" width="18" height="18">' +
      '<path class="blinker-outline" d="M28 8 L42 24 L28 40 L28 30 L6 30 L6 18 L28 18 Z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<path class="blinker-fill" d="M28 8 L42 24 L28 40 L28 30 L6 30 L6 18 L28 18 Z" fill="#f59e0b" stroke="none" opacity="0"/>' +
    '</svg>';

    var accelSVG = '<svg class="meta-accelerator-icon" viewBox="0 0 32 32" width="22" height="22">' +
      '<rect x="8" y="4" width="16" height="24" rx="3" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/>' +
      '<path d="M18 8 L13 16 L16 16 L14 24 L19 15 L16 15 L18 8 Z" fill="rgba(255,255,255,0.4)"/>' +
      '<rect class="accel-fill-rect" x="10" y="26" width="12" height="0" rx="2" fill="#73d13d" opacity="0"/>' +
    '</svg>';

    popup.innerHTML =
      '<div class="tesla-popup-video">' +
        // Header overlay (top, visible on hover)
        '<div class="tesla-popup-header">' +
          '<span class="tesla-popup-filename">' + self._escapeHtml(session.fileName) + '</span>' +
          '<button class="tesla-popup-remove" title="Kaldir">&#128465;</button>' +
          '<button class="tesla-popup-close" title="Kapat">&times;</button>' +
        '</div>' +
        '<video class="tesla-video" playsinline></video>' +
        '<div class="tesla-scrubber-wrap">' +
          '<input type="range" class="tesla-scrubber" min="0" max="100" value="0" step="0.01">' +
        '</div>' +
      // Dashboard overlay on video (Tesla original style)
      '<div class="tesla-dashboard">' +
        '<div class="metadata-dashboard">' +
          // Left: Gear + Brake
          '<div class="meta-left-col">' +
            '<div class="meta-gear">P</div>' +
            '<div class="meta-brake-container">' + brakeSVG + '</div>' +
          '</div>' +
          // Left Blinker
          '<div class="meta-blinker meta-blinker-left">' + blinkerLeftSVG + '</div>' +
          // Center: Speed
          '<div class="meta-speed-container">' +
            '<span class="meta-speed-value">0</span>' +
            '<span class="meta-speed-unit">km/h</span>' +
          '</div>' +
          // Right Blinker
          '<div class="meta-blinker meta-blinker-right">' + blinkerRightSVG + '</div>' +
          // Right: Steering + Accelerator
          '<div class="meta-right-col">' +
            '<div class="meta-steering-container">' + steeringSVG + '</div>' +
            '<div class="meta-accelerator-container">' + accelSVG + '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</div>';

    // Event handlers
    popup.querySelector('.tesla-popup-close').addEventListener('click', function() {
      self.closePopup(sessionId);
    });

    popup.querySelector('.tesla-popup-remove').addEventListener('click', function() {
      self.destroySession(sessionId);
    });

    return popup;
  },

  // ── Sync Loop (video ↔ map ↔ dashboard) ────────────────
  _startSyncLoop: function(sessionId) {
    var self = this;
    var popupData = this.activePopups[sessionId];
    if (!popupData) return;

    var session = this.activeSessions[sessionId];
    var video = popupData.video;
    var popup = popupData.popup;

    // Cache DOM references (TDashcamStudio-style selectors)
    var speedEl = popup.querySelector('.meta-speed-value');
    var gearEl = popup.querySelector('.meta-gear');
    var brakeIcon = popup.querySelector('.meta-brake-icon');
    var steeringIcon = popup.querySelector('.meta-steering-icon');
    var accelIcon = popup.querySelector('.meta-accelerator-icon');
    var accelFillRect = popup.querySelector('.accel-fill-rect');
    var blinkerLeft = popup.querySelector('.meta-blinker-left');
    var blinkerRight = popup.querySelector('.meta-blinker-right');
    var scrubber = popup.querySelector('.tesla-scrubber');

    var gearLabels = { 0: 'P', 1: 'D', 2: 'R', 3: 'N' };
    var gearColors = { 0: 'rgba(255,255,255,0.85)', 1: '#2ecc71', 2: '#e74c3c', 3: '#f39c12' };
    var lastTime = -1;

    function syncFrame() {
      if (!self.activePopups[sessionId]) return;

      var currentTime = video.currentTime;

      // Update scrubber
      if (video.duration && !isNaN(video.duration)) {
        scrubber.value = currentTime;
        if (parseFloat(scrubber.max) !== video.duration) {
          scrubber.max = video.duration;
        }
      }

      // Only update when time changed meaningfully
      if (Math.abs(currentTime - lastTime) > 0.01) {
        lastTime = currentTime;
        var meta = self.getMetadataAtTime(sessionId, currentTime);

        if (meta) {
          // ── Dashboard Update (TDashcamStudio-style) ──
          var speedKmh = Math.round((meta.vehicleSpeedMps || 0) * 3.6);
          speedEl.textContent = speedKmh;

          var gear = meta.gearState || 0;
          gearEl.textContent = gearLabels[gear] || '?';
          gearEl.style.color = gearColors[gear] || 'rgba(255,255,255,0.85)';

          // Brake icon toggle
          if (brakeIcon) {
            brakeIcon.classList.toggle('active', !!meta.brakeApplied);
          }

          // Steering wheel rotation
          var steeringAngle = meta.steeringWheelAngle || 0;
          if (steeringIcon) {
            steeringIcon.style.transform = 'rotate(' + steeringAngle + 'deg)';
          }

          // Autopilot state on steering icon
          var ap = meta.autopilotState || 0;
          if (steeringIcon) {
            steeringIcon.classList.remove('autopilot-active', 'autopilot-self-driving');
            if (ap === 1) steeringIcon.classList.add('autopilot-self-driving');
            else if (ap === 2 || ap === 3) steeringIcon.classList.add('autopilot-active');
          }

          // Accelerator fill (grows from bottom)
          var accelPct = meta.acceleratorPedalPosition || 0;
          if (accelFillRect) {
            var maxHeight = 20;
            var fillHeight = (accelPct / 100) * maxHeight;
            var yPos = 26 - fillHeight;
            accelFillRect.setAttribute('y', yPos);
            accelFillRect.setAttribute('height', fillHeight);
            accelFillRect.setAttribute('opacity', accelPct > 0 ? 0.9 : 0);
          }
          if (accelIcon) {
            accelIcon.classList.toggle('active', accelPct > 5);
          }

          // Blinkers
          blinkerLeft.classList.toggle('active', !!meta.blinkerOnLeft);
          blinkerRight.classList.toggle('active', !!meta.blinkerOnRight);

          // ── Map Position Update ──
          if (session.hasGPS && meta.latitudeDeg && meta.latitudeDeg !== 0 &&
              meta.longitudeDeg && meta.longitudeDeg !== 0) {
            session.coord = [meta.longitudeDeg, meta.latitudeDeg];
            session.bearing = meta.headingDeg || session.bearing;
            self._updateMapSource();
          }
        }
      }

      // Update popup position on map
      self._updatePopupPosition(sessionId);

      popupData.syncRAF = requestAnimationFrame(syncFrame);
    }

    popupData.syncRAF = requestAnimationFrame(syncFrame);
  },

  _updatePopupPosition: function(sessionId) {
    var popupData = this.activePopups[sessionId];
    var session = this.activeSessions[sessionId];
    if (!popupData || !session || !session.coord) return;

    var popup = popupData.popup;
    var point = this.map.project(session.coord);

    popup.style.left = point.x + 'px';
    popup.style.top = (point.y - 20) + 'px';
  },

  // ══════════════════════════════════════════════════════
  //  UPLOAD UI
  // ══════════════════════════════════════════════════════

  showUploadDialog: function() {
    var self = this;

    // Prevent duplicate
    if (document.getElementById('tesla-upload-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'tesla-upload-overlay';
    overlay.className = 'tesla-upload-overlay';

    overlay.innerHTML =
      '<div class="tesla-upload-modal">' +
        '<h3>Tesla Dashcam Yukle</h3>' +
        '<label>On kamera MP4 dosyasi secin</label>' +
        '<input type="file" id="tesla-file-input" accept="video/mp4,.mp4">' +
        '<small>Tesla dashcam on kamera kaydi (front camera)</small>' +
        '<div class="tesla-parse-progress" id="tesla-progress">' +
          '<div class="tesla-progress-text" id="tesla-progress-text"></div>' +
          '<div class="tesla-progress-bar-bg"><div class="tesla-progress-bar-fill" id="tesla-progress-fill"></div></div>' +
        '</div>' +
        '<div class="tesla-upload-actions">' +
          '<button class="tesla-btn-cancel" id="tesla-cancel-btn">Iptal</button>' +
          '<button class="tesla-btn-upload" id="tesla-upload-btn" disabled>Yukle</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) self.closeUploadDialog();
    });

    // Cancel button
    document.getElementById('tesla-cancel-btn').addEventListener('click', function() {
      self.closeUploadDialog();
    });

    // File input enables upload button
    var fileInput = document.getElementById('tesla-file-input');
    var uploadBtn = document.getElementById('tesla-upload-btn');

    fileInput.addEventListener('change', function() {
      uploadBtn.disabled = !fileInput.files.length;
    });

    // Upload button
    uploadBtn.addEventListener('click', function() {
      var file = fileInput.files[0];
      if (!file) return;

      uploadBtn.disabled = true;
      var progressEl = document.getElementById('tesla-progress');
      var progressText = document.getElementById('tesla-progress-text');
      var progressFill = document.getElementById('tesla-progress-fill');

      progressEl.classList.add('active');
      progressFill.style.width = '30%';

      self.createSession(file, function(status) {
        progressText.textContent = status;
        if (status === 'OK') {
          progressFill.style.width = '100%';
          setTimeout(function() { self.closeUploadDialog(); }, 500);
        } else if (status.indexOf('HATA') === 0) {
          progressFill.style.width = '100%';
          progressFill.style.background = '#e74c3c';
          uploadBtn.disabled = false;
        } else {
          progressFill.style.width = '60%';
        }
      });
    });
  },

  closeUploadDialog: function() {
    var overlay = document.getElementById('tesla-upload-overlay');
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  },

  // ── Inject Upload Button into Layers Dropdown ──────────
  _injectUploadButton: function() {
    var self = this;

    // Watch for the layers dropdown to be created, then inject our button
    // next to the Vehicles toggle
    var observer = new MutationObserver(function() {
      self._tryInjectButton();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Try immediately too
    this._tryInjectButton();
  },

  _tryInjectButton: function() {
    // Already injected?
    if (document.querySelector('.tesla-upload-btn')) {
      Logger.log('[Tesla] Upload button already exists');
      return;
    }

    // Find the "Vehicles" label in layers dropdown
    var labels = document.querySelectorAll('.layers-dropdown-label');
    Logger.log('[Tesla] _tryInjectButton: found', labels.length, 'labels');
    var self = this;

    labels.forEach(function(label) {
      var text = (label.textContent || '').trim();
      Logger.log('[Tesla] Label text:', JSON.stringify(text));
      if (text === 'Vehicles') {
        var btn = document.createElement('button');
        btn.className = 'tesla-upload-btn';
        btn.title = 'Tesla Dashcam Yukle';
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          self.showUploadDialog();
        });
        // Insert into the parent row, after the label
        label.parentNode.insertBefore(btn, label.nextSibling);
      }
    });
  },

  // ── Utility ────────────────────────────────────────────
  _escapeHtml: function(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};

// ── Auto-Initialize ──────────────────────────────────────
(function initTeslaDashcam() {
  Logger.log('[Tesla] initTeslaDashcam: map=' + !!window.map + ', loaded=' + (window.map && window.map.loaded && window.map.loaded()));
  if (window.map && typeof window.map.getSource === 'function') {
    if (window.map.loaded()) {
      TeslaDashcam.init(window.map);
      TeslaDashcam._injectUploadButton();
    } else {
      window.map.on('load', function() {
        TeslaDashcam.init(window.map);
        TeslaDashcam._injectUploadButton();
      });
    }
  } else {
    Logger.log('[Tesla] Map not ready, retrying in 300ms...');
    setTimeout(initTeslaDashcam, 300);
  }
})();
