/**
 * TeslaCAM Live — Canli / Arsiv mod
 * Video-based Tesla on kamera goruntusu
 */
import '../css/teslacam-live.css';
import '../css/tesla-dashcam.css';
import * as AppState from '/js/state.js';
import { QBitmapConfig } from '/js/config.js';

var TeslaCamLive = {

  // ── Config ──────────────────────────────────────────────
  API_BASE: QBitmapConfig.api.base + '/api/teslacam',
  POLL_INTERVAL: 30000,
  MAX_SEGMENTS: 10,

  // ── State ───────────────────────────────────────────────
  map: null,
  layerReady: false,
  mode: null,
  watcherRunning: false,

  segments: new Map(),     // id -> { summary, metadata }
  segmentOrder: [],
  activeSegmentId: null,
  isPlaying: false,
  pollIntervalId: null,
  nextSegmentReady: null,

  popupEl: null,
  selectorVisible: false,
  vehicleCoord: null,
  vehicleBearing: 0,
  _lastMetaIndex: -1,
  _activeVideo: 'a',

  // ── Init / Lifecycle ────────────────────────────────────
  init: function(map) {
    this.map = map;
    this._addMapLayer();
  },

  show: async function() {
    if (!this.map) return;

    var results = await Promise.all([
      this._fetchWatcherStatus(),
      this._fetchSegments()
    ]);

    var watcher = results[0];
    var segList = results[1];

    this.watcherRunning = watcher && watcher.running === true;

    if (segList && segList.segments) {
      // Sort newest-first by ID and keep MAX
      var segs = segList.segments.sort(function(a, b) { return b.id.localeCompare(a.id); }).slice(0, this.MAX_SEGMENTS);
      this.segmentOrder = segs.map(function(s) { return s.id; });
      for (var i = 0; i < segs.length; i++) {
        if (!this.segments.has(segs[i].id)) {
          this.segments.set(segs[i].id, {
            summary: segs[i],
            metadata: null
          });
        }
      }
    }

    if (this.map.getLayer('teslacam-live-vehicle')) {
      this.map.setLayoutProperty('teslacam-live-vehicle', 'visibility', 'visible');
    }

    this._startPolling();

    if (this.segmentOrder.length > 0) {
      if (this.watcherRunning) {
        await this._switchToLive();
      } else {
        this._switchToArchive();
      }
    }
  },

  hide: function() {
    this._stopPolling();
    this._stopPlayback();
    this._removePopup();
    this._clearTrail();

    if (this.map && this.map.getLayer('teslacam-live-vehicle')) {
      this.map.setLayoutProperty('teslacam-live-vehicle', 'visibility', 'none');
    }

    this.segments.clear();
    this.segmentOrder = [];
    this.activeSegmentId = null;
    this.mode = null;
    this.nextSegmentReady = null;
  },

  // ── API Methods ─────────────────────────────────────────
  _fetchWatcherStatus: async function() {
    try {
      var resp = await fetch(this.API_BASE + '/status', { credentials: 'include' });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) { return null; }
  },

  _fetchSegments: async function() {
    try {
      var resp = await fetch(this.API_BASE + '/segments', { credentials: 'include' });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) { return null; }
  },

  _fetchMetadata: async function(id) {
    try {
      var resp = await fetch(this.API_BASE + '/segments/' + id + '/metadata', { credentials: 'include' });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) { return null; }
  },

  _videoUrl: function(id) {
    return this.API_BASE + '/segments/' + id + '/video.mp4';
  },

  _preloadSegment: async function(id) {
    var seg = this.segments.get(id);
    if (!seg) return false;
    if (!seg.metadata) {
      seg.metadata = await this._fetchMetadata(id);
      if (!seg.metadata) return false;
    }
    return true;
  },

  // ── Polling ─────────────────────────────────────────────
  _startPolling: function() {
    if (this.pollIntervalId) return;
    var self = this;
    this.pollIntervalId = setInterval(function() { self._poll(); }, this.POLL_INTERVAL);
  },

  _stopPolling: function() {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  },

  _poll: async function() {
    var results = await Promise.all([
      this._fetchWatcherStatus(),
      this._fetchSegments()
    ]);

    var watcher = results[0];
    var segList = results[1];

    var wasRunning = this.watcherRunning;
    this.watcherRunning = watcher && watcher.running === true;

    if (segList && segList.segments) {
      var newSegs = segList.segments.sort(function(a, b) { return b.id.localeCompare(a.id); }).slice(0, this.MAX_SEGMENTS);
      var newIds = newSegs.map(function(s) { return s.id; });

      var self = this;
      var brandNew = [];
      for (var i = 0; i < newIds.length; i++) {
        if (!this.segments.has(newIds[i])) {
          brandNew.push(newIds[i]);
          this.segments.set(newIds[i], {
            summary: newSegs[i],
            metadata: null
          });
        }
      }

      this.segmentOrder = newIds;
      this.segments.forEach(function(val, key) {
        if (newIds.indexOf(key) === -1) self.segments.delete(key);
      });

      // Live mode: preload newest for seamless transition
      if (this.mode === 'live' && brandNew.length > 0) {
        var newest = brandNew[0];
        this._preloadSegment(newest).then(function() {
          self.nextSegmentReady = newest;
        });
      }

      if (this.selectorVisible) this._buildSegmentSelector();
    }

    // First time segments arrived
    if (!this.mode && this.segmentOrder.length > 0) {
      if (this.watcherRunning) {
        this._switchToLive();
      } else {
        this._switchToArchive();
      }
      return;
    }

    if (!wasRunning && this.watcherRunning && this.mode !== 'live') {
      this._switchToLive();
    } else if (wasRunning && !this.watcherRunning && this.mode === 'live') {
      this._pendingArchiveSwitch = true;
    }
  },

  // ── Mode Management ─────────────────────────────────────
  _switchToLive: async function() {
    this.mode = 'live';
    this._stopPlayback();

    var latestId = this.segmentOrder[0];
    if (!latestId) return;

    var self = this;
    this._preloadSegment(latestId).then(function() {
      self.activeSegmentId = latestId;
      self._updateTrail();
      if (self.popupEl) {
        self._updateBadge('live');
        self._playVideo(latestId);
      }
    });

    var coord = this._findLatestValidGps();
    if (coord) {
      this.vehicleCoord = coord;
      this._updateVehicle();
      this.map.flyTo({ center: coord, zoom: 16, duration: 1500 });
    }
  },

  _findLatestValidGps: function() {
    for (var i = 0; i < this.segmentOrder.length; i++) {
      var s = this.segments.get(this.segmentOrder[i]);
      if (!s || !s.summary) continue;
      var g = s.summary.start_gps || s.summary.end_gps;
      if (g && g[0] != null && g[1] != null) return [g[1], g[0]];
      var g2 = s.summary.end_gps;
      if (g2 && g2[0] != null && g2[1] != null) return [g2[1], g2[0]];
    }
    return null;
  },

  _switchToArchive: function() {
    this.mode = 'archive';
    this._stopPlayback();
    this._pendingArchiveSwitch = false;

    if (this.popupEl) this._updateBadge('archive');

    var coord = this._findLatestValidGps();
    if (coord) {
      this.vehicleCoord = coord;
      this._updateVehicle();
      this.map.flyTo({ center: coord, zoom: 15, duration: 1500 });
    }
  },

  // ── Video Playback ──────────────────────────────────────
  _playVideo: function(segId) {
    if (!this.popupEl) return;
    var videoA = this.popupEl.querySelector('[data-video="a"]');
    var videoB = this.popupEl.querySelector('[data-video="b"]');
    if (!videoA || !videoB) return;

    var self = this;
    var active = this._activeVideo === 'b' ? videoB : videoA;
    var next = this._activeVideo === 'b' ? videoA : videoB;

    this.activeSegmentId = segId;
    this._lastMetaIndex = -1;
    this.isPlaying = true;

    // Load new video on the hidden element
    next.src = this._videoUrl(segId);
    next.load();

    // When ready, swap: show next, hide active
    next.oncanplay = function() {
      next.oncanplay = null;
      next.style.zIndex = 2;
      next.style.opacity = 1;
      active.style.zIndex = 1;
      next.play().catch(function() {});
      // After transition, fully hide old
      setTimeout(function() {
        active.pause();
        active.style.opacity = 0;
      }, 100);
      self._activeVideo = (self._activeVideo === 'b') ? 'a' : 'b';
    };

    this._updateTrail();

    var titleEl = this.popupEl.querySelector('.teslacam-live-title');
    if (titleEl) titleEl.textContent = segId;
  },

  _stopPlayback: function() {
    this.isPlaying = false;
    if (this.popupEl) {
      var videos = this.popupEl.querySelectorAll('.teslacam-live-video');
      videos.forEach(function(v) {
        v.pause();
        v.removeAttribute('src');
        v.load();
      });
    }
  },

  _onTimeUpdate: function() {
    if (!this.popupEl || !this.activeSegmentId) return;
    var video = this.popupEl.querySelector('[data-video="' + this._activeVideo + '"]');
    if (!video) return;

    var seg = this.segments.get(this.activeSegmentId);
    if (!seg || !seg.metadata) return;

    var t = Math.floor(video.currentTime);
    if (t === this._lastMetaIndex) return;
    this._lastMetaIndex = t;

    var meta = seg.metadata[t];
    if (meta) {
      this._updateDashboard(meta);

      if (meta.latitude && meta.longitude) {
        this.vehicleCoord = [meta.longitude, meta.latitude];
        this.vehicleBearing = meta.heading_deg || this.vehicleBearing;
        this._updateVehicle();
      }
    }

    // Progress bar
    var progressFill = this.popupEl.querySelector('.teslacam-live-progress-fill');
    if (progressFill && video.duration) {
      progressFill.style.width = (video.currentTime / video.duration * 100) + '%';
    }
  },

  _onVideoEnded: function() {
    var self = this;
    if (this.mode === 'live') {
      var nextId = this.nextSegmentReady;
      this.nextSegmentReady = null;
      // Fallback: pick newest segment in list that is newer than current
      if (!nextId) {
        var curIdx = this.segmentOrder.indexOf(this.activeSegmentId);
        // segmentOrder is newest-first, so newer = curIdx - 1
        if (curIdx > 0) nextId = this.segmentOrder[curIdx - 1];
      }
      if (nextId) {
        this._preloadSegment(nextId).then(function() {
          self._playVideo(nextId);
        });
      } else {
        this._showWaiting(true);
        if (this._pendingArchiveSwitch) {
          this._switchToArchive();
        }
      }
    } else {
      // Archive: auto-play next segment (chronological order)
      var idx = this.segmentOrder.indexOf(this.activeSegmentId);
      // segmentOrder is newest-first, so next chronological = idx - 1
      if (idx > 0) {
        var nextId = this.segmentOrder[idx - 1];
        this._preloadSegment(nextId).then(function() {
          self._playVideo(nextId);
        });
      } else {
        this.isPlaying = false;
      }
    }
  },

  playArchiveSegment: async function(segId) {
    this._stopPlayback();
    this._hideSegmentSelector();

    var ok = await this._preloadSegment(segId);
    if (!ok) return;

    // Fly to start position
    var seg = this.segments.get(segId);
    if (seg && seg.metadata && seg.metadata.length > 0) {
      var first = seg.metadata[0];
      if (first.latitude && first.longitude) {
        this.vehicleCoord = [first.longitude, first.latitude];
        this.vehicleBearing = first.heading_deg || 0;
        this._updateVehicle();
        this.map.flyTo({ center: this.vehicleCoord, zoom: 16, duration: 1500 });
      }
    }

    this._playVideo(segId);
  },

  // ── Dashboard Update ────────────────────────────────────
  _updateDashboard: function(meta) {
    if (!this.popupEl) return;
    var popup = this.popupEl;

    var speedEl = popup.querySelector('.meta-speed-value');
    if (speedEl) {
      speedEl.textContent = Math.round((meta.speed_mps || 0) * 3.6);
    }

    var gearEl = popup.querySelector('.meta-gear');
    if (gearEl) {
      var gearMap = { 'PARK': 'P', 'DRIVE': 'D', 'REVERSE': 'R', 'NEUTRAL': 'N' };
      var gearColors = { 'PARK': 'rgba(255,255,255,0.85)', 'DRIVE': '#2ecc71', 'REVERSE': '#e74c3c', 'NEUTRAL': '#f39c12' };
      var gs = meta.gear_state || 'PARK';
      gearEl.textContent = gearMap[gs] || '?';
      gearEl.style.color = gearColors[gs] || 'rgba(255,255,255,0.85)';
    }

    var brakeIcon = popup.querySelector('.meta-brake-icon');
    if (brakeIcon) {
      brakeIcon.classList.toggle('active', !!meta.brake_applied);
    }

    var steeringIcon = popup.querySelector('.meta-steering-icon');
    if (steeringIcon) {
      steeringIcon.style.transform = 'rotate(' + (meta.steering_wheel_angle || 0) + 'deg)';
      steeringIcon.classList.remove('autopilot-active', 'autopilot-self-driving');
      var ap = meta.autopilot_state || 'NONE';
      if (ap === 'SELF_DRIVING') steeringIcon.classList.add('autopilot-self-driving');
      else if (ap === 'AUTOSTEER' || ap === 'TACC') steeringIcon.classList.add('autopilot-active');
    }
  },

  // ── Map Layer ───────────────────────────────────────────
  _addMapLayer: function() {
    var self = this;
    if (this.map.hasImage('tesla-vehicle-icon')) {
      this._createSourceAndLayer();
      return;
    }
    var img = new Image();
    img.onload = function() {
      if (!self.map.hasImage('tesla-vehicle-icon')) {
        self.map.addImage('tesla-vehicle-icon', img);
      }
      self._createSourceAndLayer();
    };
    img.onerror = function() { self._createSourceAndLayer(); };
    img.src = '/car1.png';
  },

  _createSourceAndLayer: function() {
    if (this.map.getSource('teslacam-live-vehicle')) {
      this.layerReady = true;
      return;
    }

    this.map.addSource('teslacam-live-vehicle', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    this.map.addLayer({
      id: 'teslacam-live-vehicle',
      type: 'symbol',
      source: 'teslacam-live-vehicle',
      minzoom: 3,
      maxzoom: 20,
      layout: {
        'icon-image': 'tesla-vehicle-icon',
        'icon-size': ['interpolate', ['linear'], ['zoom'],
          10, 0.15, 14, 0.25, 17, 0.5
        ],
        'icon-allow-overlap': true,
        'icon-rotate': ['-', ['get', 'bearing'], 90],
        'icon-rotation-alignment': 'map'
      }
    });

    this.layerReady = true;

    var self = this;
    this.map.on('click', 'teslacam-live-vehicle', function() {
      if (self.popupEl) {
        self._removePopup();
        self._stopPlayback();
      } else {
        self._openPopupAndPlay();
      }
    });
  },

  _updateVehicle: function() {
    var source = this.map.getSource('teslacam-live-vehicle');
    if (!source || !this.vehicleCoord) return;

    source.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: this.vehicleCoord },
        properties: { bearing: this.vehicleBearing || 0, id: 'teslacam' }
      }]
    });
  },

  _trailIds: [], // track active trail source/layer IDs

  _updateTrail: function() {
    var segId = this.activeSegmentId;
    var trailId = 'teslacam-trail-' + segId;

    // Already exists
    if (this.map.getSource(trailId)) return;

    var seg = this.segments.get(segId);
    if (!seg || !seg.metadata) return;

    var coords = [];
    for (var i = 0; i < seg.metadata.length; i++) {
      var m = seg.metadata[i];
      if (m.latitude && m.longitude) {
        coords.push([m.longitude, m.latitude]);
      }
    }
    if (coords.length < 2) return;

    this.map.addSource(trailId, {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }
    });

    this.map.addLayer({
      id: trailId,
      type: 'line',
      source: trailId,
      paint: {
        'line-color': '#e74c3c',
        'line-width': 3,
        'line-dasharray': [2, 2],
        'line-opacity': 0.7
      }
    });

    this._trailIds.push(trailId);

    // Keep only last 5 trails
    while (this._trailIds.length > 5) {
      var old = this._trailIds.shift();
      if (this.map.getLayer(old)) this.map.removeLayer(old);
      if (this.map.getSource(old)) this.map.removeSource(old);
    }
  },

  _clearTrail: function() {
    for (var i = 0; i < this._trailIds.length; i++) {
      var id = this._trailIds[i];
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
    this._trailIds = [];
  },

  // ── Open popup and play ─────────────────────────────────
  _openPopupAndPlay: async function() {
    if (this.popupEl) return;

    var latestId = this.activeSegmentId || this.segmentOrder[0];
    if (!latestId) return;

    await this._preloadSegment(latestId);
    this.activeSegmentId = latestId;

    this._createPopup();
    this._updateBadge(this.mode || 'archive');
    this._updateTrail();

    if (this.mode === 'live') {
      this._playVideo(latestId);
    } else {
      this._showSegmentSelector();
    }
  },

  // ── Popup UI ────────────────────────────────────────────
  _createPopup: function() {
    if (this.popupEl) return;

    var self = this;
    var popup = document.createElement('div');
    popup.className = 'teslacam-live-popup';

    // SVG Icons
    var steeringSVG = '<svg class="meta-steering-icon" viewBox="0 0 64 64" width="16" height="16">' +
      '<circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="5"/>' +
      '<circle cx="32" cy="32" r="9" fill="rgba(255,255,255,0.9)"/>' +
      '<rect x="4" y="28" width="19" height="8" rx="2" fill="rgba(255,255,255,0.9)"/>' +
      '<rect x="41" y="28" width="19" height="8" rx="2" fill="rgba(255,255,255,0.9)"/>' +
      '<rect x="28" y="41" width="8" height="19" rx="2" fill="rgba(255,255,255,0.9)"/>' +
    '</svg>';

    var brakeSVG = '<svg class="meta-brake-icon" viewBox="0 0 1024 1024" width="18" height="18">' +
      '<g class="brake-inactive"><path d="M821.394 861.482H200.242c-23.709 0-44.013-20.191-45.124-44.975 0 0-30.555-129.896-30.044-166.228 0.325-23.102 15.23-164.3 15.23-164.3 2.449-27.739 18.019-48.258 42.686-48.258h646.233c24.667 0 44.357 21.769 43.759 48.258l14.579 163.622-22.043 166.906c-0.56 24.784-20.414 44.975-44.124 44.975z m24.716-358.364l0.292-10.498c0.23-8.275-6.452-15.059-14.85-15.059H186.497c-8.397 0-14.828 6.784-14.291 15.059l0.681 10.498c0.534 8.232 7.802 14.954 16.153 14.954h641.472c8.35 0 15.37-6.722 15.598-14.954z m8.739 81.304l0.296-10.264c0.233-8.091-6.628-14.724-15.248-14.724H177.735c-8.62 0-15.226 6.633-14.681 14.724l0.691 10.264c0.542 8.049 7.999 14.622 16.571 14.622H838.84c8.574 0 15.777-6.572 16.009-14.622z m6.172 79.506l0.298-10.038c0.235-7.912-6.747-14.399-15.516-14.399H172.234c-8.769 0-15.494 6.487-14.945 14.399l0.695 10.038c0.545 7.872 8.126 14.3 16.847 14.3h669.91c8.721 0 16.047-6.428 16.28-14.3z m-14.901 77.765l0.282-9.819c0.222-7.74-6.466-14.085-14.863-14.085H186.526c-8.397 0-14.841 6.345-14.322 14.085l0.659 9.819c0.517 7.701 7.772 13.989 16.123 13.989h641.548c8.351 0 15.365-6.288 15.586-13.989z m-8.749 76.081l0.267-9.608c0.21-7.573-6.189-13.781-14.222-13.781H206.385c-8.033 0-14.202 6.208-13.711 13.781l0.623 9.608c0.489 7.535 7.425 13.688 15.415 13.688h613.751c7.99 0.001 14.698-6.152 14.908-13.688z m1.869-378.856l36.038-94.167 21.623-119.775H785.183L752.749 356.56l-118.926 82.358H839.24z" fill="rgba(255,255,255,0.3)"/></g>' +
      '<g class="brake-active"><path d="M821.394 861.482H200.242c-23.709 0-44.013-20.191-45.124-44.975 0 0-30.555-129.896-30.044-166.228 0.325-23.102 15.23-164.3 15.23-164.3 2.449-27.739 18.019-48.258 42.686-48.258h646.233c24.667 0 44.357 21.769 43.759 48.258l14.579 163.622-22.043 166.906c-0.56 24.784-20.414 44.975-44.124 44.975z m24.716-358.364l0.292-10.498c0.23-8.275-6.452-15.059-14.85-15.059H186.497c-8.397 0-14.828 6.784-14.291 15.059l0.681 10.498c0.534 8.232 7.802 14.954 16.153 14.954h641.472c8.35 0 15.37-6.722 15.598-14.954z m8.739 81.304l0.296-10.264c0.233-8.091-6.628-14.724-15.248-14.724H177.735c-8.62 0-15.226 6.633-14.681 14.724l0.691 10.264c0.542 8.049 7.999 14.622 16.571 14.622H838.84c8.574 0 15.777-6.572 16.009-14.622z m6.172 79.506l0.298-10.038c0.235-7.912-6.747-14.399-15.516-14.399H172.234c-8.769 0-15.494 6.487-14.945 14.399l0.695 10.038c0.545 7.872 8.126 14.3 16.847 14.3h669.91c8.721 0 16.047-6.428 16.28-14.3z m-14.901 77.765l0.282-9.819c0.222-7.74-6.466-14.085-14.863-14.085H186.526c-8.397 0-14.841 6.345-14.322 14.085l0.659 9.819c0.517 7.701 7.772 13.989 16.123 13.989h641.548c8.351 0 15.365-6.288 15.586-13.989z m-8.749 76.081l0.267-9.608c0.21-7.573-6.189-13.781-14.222-13.781H206.385c-8.033 0-14.202 6.208-13.711 13.781l0.623 9.608c0.489 7.535 7.425 13.688 15.415 13.688h613.751c7.99 0.001 14.698-6.152 14.908-13.688z m1.869-378.856l36.038-94.167 21.623-119.775H785.183L752.749 356.56l-118.926 82.358H839.24z" fill="#ff4d4f"/></g>' +
    '</svg>';

    popup.innerHTML =
      '<div class="teslacam-live-container">' +
        '<div class="teslacam-live-header">' +
          '<span class="teslacam-live-title"></span>' +
          '<span class="teslacam-live-badge ' + (this.mode === 'live' ? 'live' : 'archive') + '">' +
            (this.mode === 'live' ? 'CANLI' : 'ARSIV') +
          '</span>' +
          '<button class="teslacam-live-close" title="Kapat">&times;</button>' +
        '</div>' +
        '<video class="teslacam-live-video" data-video="a" playsinline muted style="z-index:2;opacity:1"></video>' +
        '<video class="teslacam-live-video" data-video="b" playsinline muted style="z-index:1;opacity:0"></video>' +
        '<div class="teslacam-live-waiting">Sonraki segment bekleniyor...</div>' +
        '<div class="tesla-dashboard">' +
          '<div class="metadata-dashboard">' +
            '<div class="meta-left-col">' +
              '<div class="meta-gear">P</div>' +
              '<div class="meta-brake-container">' + brakeSVG + '</div>' +
            '</div>' +
            '<div class="meta-speed-container">' +
              '<span class="meta-speed-value">0</span>' +
              '<span class="meta-speed-unit">km/h</span>' +
            '</div>' +
            '<div class="meta-right-col">' +
              '<div class="meta-steering-container">' + steeringSVG + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="teslacam-live-progress"><div class="teslacam-live-progress-fill"></div></div>' +
      '</div>' +
      '<div class="teslacam-live-segment-selector"></div>';

    // Close button
    popup.querySelector('.teslacam-live-close').addEventListener('click', function(e) {
      e.stopPropagation();
      self._removePopup();
    });

    // Video events — bind to both video elements
    var videos = popup.querySelectorAll('.teslacam-live-video');
    videos.forEach(function(v) {
      v.addEventListener('timeupdate', function() { self._onTimeUpdate(); });
      v.addEventListener('ended', function() { self._onVideoEnded(); });
      v.addEventListener('click', function() {
        var active = popup.querySelector('[data-video="' + self._activeVideo + '"]');
        if (self.mode === 'archive') {
          if (active && active.paused) { active.play(); self.isPlaying = true; }
          else if (active) { active.pause(); self.isPlaying = false; }
        } else {
          self._toggleSegmentSelector();
        }
      });
      v.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        popup.querySelector('.teslacam-live-container').classList.toggle('native');
      });
    });

    // Progress bar seek
    var progressBar = popup.querySelector('.teslacam-live-progress');
    if (progressBar) {
      progressBar.addEventListener('click', function(e) {
        e.stopPropagation();
        var active = popup.querySelector('[data-video="' + self._activeVideo + '"]');
        if (!active || !active.duration) return;
        var rect = progressBar.getBoundingClientRect();
        var pct = (e.clientX - rect.left) / rect.width;
        active.currentTime = pct * active.duration;
      });
    }

    // Badge click: segment selector
    popup.querySelector('.teslacam-live-badge').addEventListener('click', function(e) {
      e.stopPropagation();
      self._toggleSegmentSelector();
    });

    // Drag
    var header = popup.querySelector('.teslacam-live-header');
    var dragging = false, dragX = 0, dragY = 0;
    var dragRaf = 0, dragLastX = 0, dragLastY = 0;

    function startDrag(clientX, clientY, e) {
      if (e.target.closest('.teslacam-live-close')) return;
      dragging = true;
      var rect = popup.getBoundingClientRect();
      dragX = clientX - rect.left;
      dragY = clientY - rect.top;
      e.preventDefault();
    }
    function moveDrag(clientX, clientY) {
      if (!dragging) return;
      dragLastX = clientX;
      dragLastY = clientY;
      if (dragRaf) return;
      dragRaf = requestAnimationFrame(function () {
        dragRaf = 0;
        if (!dragging) return;
        popup.style.right = 'auto';
        popup.style.bottom = 'auto';
        popup.style.left = (dragLastX - dragX) + 'px';
        popup.style.top = (dragLastY - dragY) + 'px';
      });
    }
    function endDrag() {
      dragging = false;
      if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
    }

    header.addEventListener('mousedown', function(e) { startDrag(e.clientX, e.clientY, e); });
    document.addEventListener('mousemove', function(e) { moveDrag(e.clientX, e.clientY); });
    document.addEventListener('mouseup', endDrag);
    header.addEventListener('touchstart', function(e) { startDrag(e.touches[0].clientX, e.touches[0].clientY, e); });
    document.addEventListener('touchmove', function(e) { if (dragging) moveDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    document.addEventListener('touchend', endDrag);

    document.body.appendChild(popup);
    this.popupEl = popup;

    requestAnimationFrame(function() { popup.classList.add('active'); });
  },

  _removePopup: function() {
    if (!this.popupEl) return;
    this._stopPlayback();
    this.popupEl.classList.remove('active');
    var el = this.popupEl;
    this.popupEl = null;
    this.selectorVisible = false;
    this._activeVideo = 'a';
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 300);
  },

  _updatePopupPosition: function() {},

  _updateBadge: function(mode) {
    if (!this.popupEl) return;
    var badge = this.popupEl.querySelector('.teslacam-live-badge');
    if (!badge) return;
    badge.className = 'teslacam-live-badge ' + mode;
    badge.textContent = mode === 'live' ? 'CANLI' : 'ARSIV';
  },

  _showWaiting: function(show) {
    if (!this.popupEl) return;
    var el = this.popupEl.querySelector('.teslacam-live-waiting');
    if (el) el.classList.toggle('visible', show);
  },

  // ── Segment Selector ────────────────────────────────────
  _toggleSegmentSelector: function() {
    if (this.selectorVisible) this._hideSegmentSelector();
    else this._showSegmentSelector();
  },

  _showSegmentSelector: function() {
    this._buildSegmentSelector();
    this.selectorVisible = true;
    if (this.popupEl) {
      var sel = this.popupEl.querySelector('.teslacam-live-segment-selector');
      if (sel) sel.classList.add('visible');
    }
  },

  _hideSegmentSelector: function() {
    this.selectorVisible = false;
    if (this.popupEl) {
      var sel = this.popupEl.querySelector('.teslacam-live-segment-selector');
      if (sel) sel.classList.remove('visible');
    }
  },

  _buildSegmentSelector: function() {
    if (!this.popupEl) return;
    var sel = this.popupEl.querySelector('.teslacam-live-segment-selector');
    if (!sel) return;

    var self = this;
    var html = '';
    for (var i = 0; i < this.segmentOrder.length; i++) {
      var id = this.segmentOrder[i];
      var seg = this.segments.get(id);
      var isActive = id === this.activeSegmentId;
      var speedTxt = '';
      if (seg && seg.summary && seg.summary.start_speed_mps !== undefined) {
        speedTxt = Math.round(seg.summary.start_speed_mps * 3.6) + ' km/h';
      }
      var displayTime = id.replace(/_/g, ' ').replace(/-/g, ':').replace(/ (\d{2}):/, ' $1:');

      html += '<div class="teslacam-live-segment-item' + (isActive ? ' active' : '') + '" data-segment="' + id + '">' +
        '<span class="teslacam-live-segment-time">' + displayTime + '</span>' +
        '<span class="teslacam-live-segment-speed">' + speedTxt + '</span>' +
      '</div>';
    }

    sel.innerHTML = html;
    sel.querySelectorAll('.teslacam-live-segment-item').forEach(function(item) {
      item.addEventListener('click', function() {
        self.playArchiveSegment(item.getAttribute('data-segment'));
      });
    });
  }
};

// ── Auto-Initialize ──────────────────────────────────────
(function initTeslaCamLive() {
  if (AppState.map && typeof AppState.map.getSource === 'function') {
    if (AppState.map.isStyleLoaded()) {
      TeslaCamLive.init(AppState.map);
    } else {
      AppState.map.on('load', function() {
        TeslaCamLive.init(AppState.map);
      });
    }
  } else {
    setTimeout(initTeslaCamLive, 300);
  }
})();

export { TeslaCamLive };
window.TeslaCamLive = TeslaCamLive;
