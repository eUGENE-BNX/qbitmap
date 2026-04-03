/**
 * TeslaCAM Live — Canli / Arsiv mod
 * teslacam.qbitmap.com API uzerinden Tesla on kamera goruntusu
 */
import '../css/teslacam-live.css';
import '../css/tesla-dashcam.css'; // dashboard stilleri icin
import * as AppState from '/js/state.js';
import { QBitmapConfig } from '/js/config.js';

var TeslaCamLive = {

  // ── Config ──────────────────────────────────────────────
  API_BASE: QBitmapConfig.api.base + '/api/teslacam',
  POLL_INTERVAL: 30000,   // 30sn
  FRAME_INTERVAL: 4000,   // 4sn (frame arasi)
  MAX_SEGMENTS: 10,

  // ── State ───────────────────────────────────────────────
  map: null,
  layerReady: false,
  mode: null,             // 'live' | 'archive'
  watcherRunning: false,

  segments: new Map(),     // id -> { manifest, frameMetas: Map, frameImages: Map }
  segmentOrder: [],        // newest first
  activeSegmentId: null,
  currentFrameIndex: 0,
  isPlaying: false,
  pollIntervalId: null,
  frameIntervalId: null,
  nextSegmentReady: null,  // preloaded next segment id (live mode)

  popupEl: null,
  selectorVisible: false,
  vehicleCoord: null,
  vehicleBearing: 0,

  // ── Init / Lifecycle ────────────────────────────────────
  init: function(map) {
    this.map = map;
    this._addMapLayer();
  },

  show: async function() {
    if (!this.map) return;

    // Check watcher status and fetch segments in parallel
    var results = await Promise.all([
      this._fetchWatcherStatus(),
      this._fetchSegments()
    ]);

    var watcher = results[0];
    var segList = results[1];

    this.watcherRunning = watcher && watcher.running === true;

    // Store segments (newest first)
    if (segList && segList.segments) {
      var segs = segList.segments.slice(0, this.MAX_SEGMENTS);
      this.segmentOrder = segs.map(function(s) { return s.id; });
      for (var i = 0; i < segs.length; i++) {
        if (!this.segments.has(segs[i].id)) {
          this.segments.set(segs[i].id, {
            summary: segs[i],
            manifest: null,
            frameMetas: new Map(),
            frameImages: new Map()
          });
        }
      }
    }

    // Show layer
    if (this.map.getLayer('teslacam-live-vehicle')) {
      this.map.setLayoutProperty('teslacam-live-vehicle', 'visibility', 'visible');
    }

    // Start polling regardless (new segments will appear)
    this._startPolling();

    // If segments exist, show car icon + flyTo
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

    // Hide layer
    if (this.map && this.map.getLayer('teslacam-live-vehicle')) {
      this.map.setLayoutProperty('teslacam-live-vehicle', 'visibility', 'none');
    }

    this.segments.clear();
    this.segmentOrder = [];
    this.activeSegmentId = null;
    this.currentFrameIndex = 0;
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

  _fetchManifest: async function(id) {
    try {
      var resp = await fetch(this.API_BASE + '/segments/' + id + '/manifest', { credentials: 'include' });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) { return null; }
  },

  _fetchFrameMeta: async function(id, num) {
    try {
      var resp = await fetch(this.API_BASE + '/segments/' + id + '/frames/' + num + '.json', { credentials: 'include' });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) { return null; }
  },

  _frameUrl: function(id, num) {
    return this.API_BASE + '/segments/' + id + '/frames/' + num + '.jpg';
  },

  _preloadSegment: async function(id) {
    var seg = this.segments.get(id);
    if (!seg) return false;

    // Fetch manifest if not cached
    if (!seg.manifest) {
      seg.manifest = await this._fetchManifest(id);
      if (!seg.manifest) return false;
    }

    // Preload all 15 frames (images + metadata) in parallel
    var self = this;
    var promises = [];
    for (var i = 1; i <= 15; i++) {
      (function(num) {
        // Preload image
        if (!seg.frameImages.has(num)) {
          promises.push(new Promise(function(resolve) {
            var img = new Image();
            img.onload = function() {
              seg.frameImages.set(num, img);
              resolve();
            };
            img.onerror = function() { resolve(); };
            img.src = self._frameUrl(id, num);
          }));
        }
        // Fetch metadata
        if (!seg.frameMetas.has(num)) {
          promises.push(
            self._fetchFrameMeta(id, num).then(function(meta) {
              if (meta) seg.frameMetas.set(num, meta);
            })
          );
        }
      })(i);
    }

    await Promise.all(promises);
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

    // Update segment list
    if (segList && segList.segments) {
      var newSegs = segList.segments.slice(0, this.MAX_SEGMENTS);
      var newIds = newSegs.map(function(s) { return s.id; });

      // Detect new segments
      var self = this;
      var brandNew = [];
      for (var i = 0; i < newIds.length; i++) {
        if (!this.segments.has(newIds[i])) {
          brandNew.push(newIds[i]);
          this.segments.set(newIds[i], {
            summary: newSegs[i],
            manifest: null,
            frameMetas: new Map(),
            frameImages: new Map()
          });
        }
      }

      // Remove old segments beyond MAX
      this.segmentOrder = newIds;
      this.segments.forEach(function(val, key) {
        if (newIds.indexOf(key) === -1) {
          self.segments.delete(key);
        }
      });

      // In live mode: preload newest segment for seamless transition
      if (this.mode === 'live' && brandNew.length > 0) {
        var newest = brandNew[0];
        this._preloadSegment(newest).then(function() {
          self.nextSegmentReady = newest;
        });
      }

      // Update segment selector if visible
      if (this.selectorVisible) {
        this._buildSegmentSelector();
      }
    }

    // First time segments arrived — show car icon
    if (!this.mode && this.segmentOrder.length > 0) {
      if (this.watcherRunning) {
        this._switchToLive();
      } else {
        this._switchToArchive();
      }
      return;
    }

    // Mode transition
    if (!wasRunning && this.watcherRunning && this.mode !== 'live') {
      this._switchToLive();
    } else if (wasRunning && !this.watcherRunning && this.mode === 'live') {
      // Let current playback finish, then switch to archive
      this._pendingArchiveSwitch = true;
    }
  },

  // ── Mode Management ─────────────────────────────────────
  _switchToLive: async function() {
    this.mode = 'live';
    this._stopPlayback();

    var latestId = this.segmentOrder[0];
    if (!latestId) return;

    // Preload latest segment in background
    var self = this;
    this._preloadSegment(latestId).then(function() {
      self.activeSegmentId = latestId;
      self.currentFrameIndex = 0;
      self._updateTrail();

      // If popup is already open, start playback
      if (self.popupEl) {
        self._updateBadge('live');
        self._startPlayback();
      }
    });

    // Show car icon + flyTo immediately (use manifest or summary GPS)
    var seg = this.segments.get(latestId);
    if (seg && seg.summary) {
      var gps = seg.summary.start_gps;
      if (gps && gps[0] !== null) {
        this.vehicleCoord = [gps[1], gps[0]]; // [lng, lat]
        this._updateVehicle();
        this.map.flyTo({ center: this.vehicleCoord, zoom: 16, duration: 1500 });
      }
    }
  },

  _switchToArchive: function() {
    this.mode = 'archive';
    this._stopPlayback();
    this._pendingArchiveSwitch = false;

    if (this.popupEl) {
      this._updateBadge('archive');
    }

    // Show car icon at last known position + flyTo
    if (this.segmentOrder.length > 0) {
      var latestId = this.segmentOrder[0];
      var seg = this.segments.get(latestId);
      if (seg && seg.summary) {
        var gps = seg.summary.start_gps;
        if (gps && gps[0] !== null) {
          this.vehicleCoord = [gps[1], gps[0]]; // [lng, lat]
          this._updateVehicle();
          this.map.flyTo({ center: this.vehicleCoord, zoom: 15, duration: 1500 });
        }
      }
    }
  },

  // ── Playback ────────────────────────────────────────────
  _startPlayback: function() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this._showFrame();

    var self = this;
    this.frameIntervalId = setInterval(function() {
      self._advanceFrame();
    }, this.FRAME_INTERVAL);
  },

  _stopPlayback: function() {
    this.isPlaying = false;
    if (this.frameIntervalId) {
      clearInterval(this.frameIntervalId);
      this.frameIntervalId = null;
    }
  },

  _advanceFrame: function() {
    this.currentFrameIndex++;

    if (this.currentFrameIndex >= 15) {
      // Segment finished
      if (this.mode === 'live') {
        if (this.nextSegmentReady) {
          // Seamless transition to next segment
          this.activeSegmentId = this.nextSegmentReady;
          this.nextSegmentReady = null;
          this.currentFrameIndex = 0;
          this._updateTrail();
          this._showFrame();
          return;
        } else {
          // Wait for next segment
          this.currentFrameIndex = 14; // stay on last frame
          this._showWaiting(true);

          if (this._pendingArchiveSwitch) {
            this._switchToArchive();
          }
          return;
        }
      } else {
        // Archive mode: stop at end
        this.currentFrameIndex = 14;
        this._stopPlayback();
        return;
      }
    }

    this._showWaiting(false);
    this._showFrame();
  },

  _showFrame: function() {
    var segId = this.activeSegmentId;
    var frameNum = this.currentFrameIndex + 1; // API uses 1-based
    var seg = this.segments.get(segId);
    if (!seg || !this.popupEl) return;

    // Update image
    var imgEl = this.popupEl.querySelector('.teslacam-live-frame');
    if (imgEl) {
      var cached = seg.frameImages.get(frameNum);
      if (cached) {
        imgEl.src = cached.src;
      } else {
        imgEl.src = this._frameUrl(segId, frameNum);
      }
    }

    // Update progress dots
    var dots = this.popupEl.querySelectorAll('.teslacam-live-dot');
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('active', i === this.currentFrameIndex);
    }

    // Update dashboard with metadata
    var meta = seg.frameMetas.get(frameNum);
    if (meta) {
      this._updateDashboard(meta);

      // Update vehicle position
      if (meta.latitude_deg && meta.longitude_deg) {
        this.vehicleCoord = [meta.longitude_deg, meta.latitude_deg];
        this.vehicleBearing = meta.heading_deg || this.vehicleBearing;
        this._updateVehicle();
        this._updatePopupPosition();
      }
    } else if (seg.manifest && seg.manifest[this.currentFrameIndex]) {
      // Fallback to manifest data (limited fields)
      var mf = seg.manifest[this.currentFrameIndex];
      if (mf.latitude && mf.longitude) {
        this.vehicleCoord = [mf.longitude, mf.latitude];
        this.vehicleBearing = mf.heading_deg || this.vehicleBearing;
        this._updateVehicle();
        this._updatePopupPosition();
      }
      // Update speed from manifest
      if (this.popupEl && mf.speed_mps !== undefined) {
        var speedEl = this.popupEl.querySelector('.meta-speed-value');
        if (speedEl) speedEl.textContent = Math.round(mf.speed_mps * 3.6);
      }
    }

    // Update title
    var titleEl = this.popupEl.querySelector('.teslacam-live-title');
    if (titleEl) {
      titleEl.textContent = segId + ' (' + frameNum + '/15)';
    }
  },

  playArchiveSegment: async function(segId) {
    this._stopPlayback();
    this._hideSegmentSelector();

    // Preload segment
    var ok = await this._preloadSegment(segId);
    if (!ok) return;

    this.activeSegmentId = segId;
    this.currentFrameIndex = 0;

    // Fly to start position
    var seg = this.segments.get(segId);
    if (seg && seg.manifest && seg.manifest.length > 0) {
      var first = seg.manifest[0];
      if (first.latitude && first.longitude) {
        this.vehicleCoord = [first.longitude, first.latitude];
        this.vehicleBearing = first.heading_deg || 0;
        this._updateVehicle();
        this.map.flyTo({ center: this.vehicleCoord, zoom: 16, duration: 1500 });
      }
    }

    this._updateTrail();
    this._startPlayback();
  },

  // ── Dashboard Update ────────────────────────────────────
  _updateDashboard: function(meta) {
    if (!this.popupEl) return;
    var popup = this.popupEl;

    // Speed
    var speedEl = popup.querySelector('.meta-speed-value');
    if (speedEl) {
      var speed = meta.vehicle_speed_mps || 0;
      speedEl.textContent = Math.round(speed * 3.6);
    }

    // Gear
    var gearEl = popup.querySelector('.meta-gear');
    if (gearEl) {
      var gearMap = { 'PARK': 'P', 'DRIVE': 'D', 'REVERSE': 'R', 'NEUTRAL': 'N' };
      var gearColors = { 'PARK': 'rgba(255,255,255,0.85)', 'DRIVE': '#2ecc71', 'REVERSE': '#e74c3c', 'NEUTRAL': '#f39c12' };
      var gs = meta.gear_state || 'PARK';
      gearEl.textContent = gearMap[gs] || '?';
      gearEl.style.color = gearColors[gs] || 'rgba(255,255,255,0.85)';
    }

    // Brake
    var brakeIcon = popup.querySelector('.meta-brake-icon');
    if (brakeIcon) {
      brakeIcon.classList.toggle('active', !!meta.brake_applied);
    }

    // Steering wheel
    var steeringIcon = popup.querySelector('.meta-steering-icon');
    if (steeringIcon) {
      steeringIcon.style.transform = 'rotate(' + (meta.steering_wheel_angle || 0) + 'deg)';

      // Autopilot state
      steeringIcon.classList.remove('autopilot-active', 'autopilot-self-driving');
      var ap = meta.autopilot_state || 'NONE';
      if (ap === 'SELF_DRIVING') steeringIcon.classList.add('autopilot-self-driving');
      else if (ap === 'AUTOSTEER' || ap === 'TACC') steeringIcon.classList.add('autopilot-active');
    }

    // Accelerator
    var accelFillRect = popup.querySelector('.accel-fill-rect');
    var accelIcon = popup.querySelector('.meta-accelerator-icon');
    var accelPct = meta.accelerator_pedal_position || 0;
    if (accelFillRect) {
      var maxHeight = 20;
      var fillHeight = (accelPct / 100) * maxHeight;
      accelFillRect.setAttribute('y', 26 - fillHeight);
      accelFillRect.setAttribute('height', fillHeight);
      accelFillRect.setAttribute('opacity', accelPct > 0 ? 0.9 : 0);
    }
    if (accelIcon) {
      accelIcon.classList.toggle('active', accelPct > 5);
    }

    // Blinkers
    var blinkerLeft = popup.querySelector('.meta-blinker-left');
    var blinkerRight = popup.querySelector('.meta-blinker-right');
    if (blinkerLeft) blinkerLeft.classList.toggle('active', !!meta.blinker_on_left);
    if (blinkerRight) blinkerRight.classList.toggle('active', !!meta.blinker_on_right);
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
    img.onerror = function() {
      self._createSourceAndLayer();
    };
    img.src = '/car.png';
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

    // Click handler — toggle popup
    var self = this;
    this.map.on('click', 'teslacam-live-vehicle', function() {
      if (self.popupEl) {
        self._removePopup();
        self._stopPlayback();
      } else {
        self._openPopupAndPlay();
      }
    });

    // Move handler — update popup position
    this.map.on('move', function() {
      self._updatePopupPosition();
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
        properties: { bearing: this.vehicleBearing || 0 }
      }]
    });
  },

  _updateTrail: function() {
    this._clearTrail();

    var seg = this.segments.get(this.activeSegmentId);
    if (!seg || !seg.manifest) return;

    var coords = [];
    for (var i = 0; i < seg.manifest.length; i++) {
      var m = seg.manifest[i];
      if (m.latitude && m.longitude && m.latitude !== null && m.longitude !== null) {
        coords.push([m.longitude, m.latitude]);
      }
    }
    if (coords.length < 2) return;

    this.map.addSource('teslacam-live-trail', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords }
      }
    });

    this.map.addLayer({
      id: 'teslacam-live-trail',
      type: 'line',
      source: 'teslacam-live-trail',
      paint: {
        'line-color': '#e74c3c',
        'line-width': 3,
        'line-dasharray': [2, 2],
        'line-opacity': 0.7
      }
    });
  },

  _clearTrail: function() {
    if (this.map.getLayer('teslacam-live-trail')) this.map.removeLayer('teslacam-live-trail');
    if (this.map.getSource('teslacam-live-trail')) this.map.removeSource('teslacam-live-trail');
  },

  // ── Open popup and start playback based on mode ──────────
  _openPopupAndPlay: async function() {
    if (this.popupEl) return;

    var latestId = this.segmentOrder[0];
    if (!latestId) return;

    // Ensure segment is preloaded
    if (!this.activeSegmentId) {
      this.activeSegmentId = latestId;
      this.currentFrameIndex = 0;
    }

    await this._preloadSegment(this.activeSegmentId);

    this._createPopup();
    this._updateBadge(this.mode || 'archive');
    this._updateTrail();
    this._showFrame();

    if (this.mode === 'live') {
      this._startPlayback();
    } else {
      // Archive: show segment selector, user picks one to play
      this._showSegmentSelector();
    }
  },

  // ── Popup UI ────────────────────────────────────────────
  _createPopup: function() {
    if (this.popupEl) return;

    var self = this;
    var popup = document.createElement('div');
    popup.className = 'teslacam-live-popup';

    // SVG Icons (from tesla-dashcam.js)
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

    var blinkerLeftSVG = '<svg viewBox="0 0 48 48" width="14" height="14">' +
      '<path class="blinker-outline" d="M20 8 L6 24 L20 40 L20 30 L42 30 L42 18 L20 18 Z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<path class="blinker-fill" d="M20 8 L6 24 L20 40 L20 30 L42 30 L42 18 L20 18 Z" fill="#f59e0b" stroke="none" opacity="0"/>' +
    '</svg>';

    var blinkerRightSVG = '<svg viewBox="0 0 48 48" width="14" height="14">' +
      '<path class="blinker-outline" d="M28 8 L42 24 L28 40 L28 30 L6 30 L6 18 L28 18 Z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<path class="blinker-fill" d="M28 8 L42 24 L28 40 L28 30 L6 30 L6 18 L28 18 Z" fill="#f59e0b" stroke="none" opacity="0"/>' +
    '</svg>';

    var accelSVG = '<svg class="meta-accelerator-icon" viewBox="0 0 32 32" width="18" height="18">' +
      '<rect x="8" y="4" width="16" height="24" rx="3" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/>' +
      '<path d="M18 8 L13 16 L16 16 L14 24 L19 15 L16 15 L18 8 Z" fill="rgba(255,255,255,0.4)"/>' +
      '<rect class="accel-fill-rect" x="10" y="26" width="12" height="0" rx="2" fill="#73d13d" opacity="0"/>' +
    '</svg>';

    // Build progress dots
    var dotsHtml = '';
    for (var i = 0; i < 15; i++) {
      dotsHtml += '<div class="teslacam-live-dot" data-frame="' + i + '"></div>';
    }

    popup.innerHTML =
      '<div class="teslacam-live-container">' +
        '<div class="teslacam-live-header">' +
          '<span class="teslacam-live-title"></span>' +
          '<span class="teslacam-live-badge ' + (this.mode === 'live' ? 'live' : 'archive') + '">' +
            (this.mode === 'live' ? 'CANLI' : 'ARSIV') +
          '</span>' +
          '<button class="teslacam-live-close" title="Kapat">&times;</button>' +
        '</div>' +
        '<img class="teslacam-live-frame" src="" alt="TeslaCAM">' +
        '<div class="teslacam-live-waiting">Sonraki segment bekleniyor...</div>' +
        '<div class="tesla-dashboard">' +
          '<div class="metadata-dashboard">' +
            '<div class="meta-left-col">' +
              '<div class="meta-gear">P</div>' +
              '<div class="meta-brake-container">' + brakeSVG + '</div>' +
            '</div>' +
            '<div class="meta-blinker meta-blinker-left">' + blinkerLeftSVG + '</div>' +
            '<div class="meta-speed-container">' +
              '<span class="meta-speed-value">0</span>' +
              '<span class="meta-speed-unit">km/h</span>' +
            '</div>' +
            '<div class="meta-blinker meta-blinker-right">' + blinkerRightSVG + '</div>' +
            '<div class="meta-right-col">' +
              '<div class="meta-steering-container">' + steeringSVG + '</div>' +
              '<div class="meta-accelerator-container">' + accelSVG + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="teslacam-live-progress">' + dotsHtml + '</div>' +
      '</div>' +
      '<div class="teslacam-live-segment-selector"></div>';

    // Close button
    popup.querySelector('.teslacam-live-close').addEventListener('click', function() {
      self._removePopup();
    });

    // Click on frame: toggle play/pause (archive mode) or show segment selector
    popup.querySelector('.teslacam-live-frame').addEventListener('click', function() {
      if (self.mode === 'archive') {
        if (self.isPlaying) {
          self._stopPlayback();
        } else if (self.activeSegmentId) {
          self._startPlayback();
        }
      } else {
        self._toggleSegmentSelector();
      }
    });

    // Click on dots: jump to frame
    var dotEls = popup.querySelectorAll('.teslacam-live-dot');
    dotEls.forEach(function(dot) {
      dot.addEventListener('click', function(e) {
        e.stopPropagation();
        var frameIdx = parseInt(dot.getAttribute('data-frame'));
        self.currentFrameIndex = frameIdx;
        self._showFrame();
      });
    });

    // Badge click: toggle segment selector
    popup.querySelector('.teslacam-live-badge').addEventListener('click', function(e) {
      e.stopPropagation();
      self._toggleSegmentSelector();
    });

    document.body.appendChild(popup);
    this.popupEl = popup;

    // Animate in
    requestAnimationFrame(function() {
      popup.classList.add('active');
    });

    this._updatePopupPosition();
  },

  _removePopup: function() {
    if (!this.popupEl) return;
    this.popupEl.classList.remove('active');
    var el = this.popupEl;
    this.popupEl = null;
    this.selectorVisible = false;
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 300);
  },

  _updatePopupPosition: function() {
    if (!this.popupEl || !this.vehicleCoord || !this.map) return;
    var point = this.map.project(this.vehicleCoord);
    this.popupEl.style.left = point.x + 'px';
    this.popupEl.style.top = (point.y - 20) + 'px';
  },

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
    if (this.selectorVisible) {
      this._hideSegmentSelector();
    } else {
      this._showSegmentSelector();
    }
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
      // Format timestamp for display
      var displayTime = id.replace(/_/g, ' ').replace(/-/g, ':').replace(/ (\d{2}):/, ' $1:');

      html += '<div class="teslacam-live-segment-item' + (isActive ? ' active' : '') + '" data-segment="' + id + '">' +
        '<span class="teslacam-live-segment-time">' + displayTime + '</span>' +
        '<span class="teslacam-live-segment-speed">' + speedTxt + '</span>' +
      '</div>';
    }

    sel.innerHTML = html;

    // Click handlers
    var items = sel.querySelectorAll('.teslacam-live-segment-item');
    items.forEach(function(item) {
      item.addEventListener('click', function() {
        var segId = item.getAttribute('data-segment');
        self.playArchiveSegment(segId);
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
