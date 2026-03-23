import { QBitmapConfig } from './config.js';
import { AuthSystem } from './auth.js';
import { escapeHtml } from './utils.js';

/**
 * Multi-Vehicle Animation System
 * Supports multiple vehicles with plates and camera integration
 * Multiple popups can be shown simultaneously
 */

const VehicleAnimation = {
  // Route definitions
  routes: {
    // Ataşehir Bulvarı
    atasehirBulvari: [
      [29.1068122, 40.9950482],
      [29.1075374, 40.9948404],
      [29.1082912, 40.9945978],
      [29.1092362, 40.9942906],
      [29.1107882, 40.9937676],
      [29.1111709, 40.9936481],
      [29.1117510, 40.9934446],
      [29.1125882, 40.9932481],
      [29.1129199, 40.9931780],
      [29.1148284, 40.9926722],
      [29.1157784, 40.9926203],
      [29.1167777, 40.9925817],
      [29.1176282, 40.9926231],
      [29.1186757, 40.9926888],
      [29.1200271, 40.9927868],
      [29.1224301, 40.9929745],
      [29.1240306, 40.9930892],
      [29.1252847, 40.9930257],
      [29.1264807, 40.9928271],
      [29.1270895, 40.9928343],
      [29.1287120, 40.9922682],
      [29.1300397, 40.9919680],
      [29.1322918, 40.9914479],
      [29.1339320, 40.9910606],
      [29.1354125, 40.9907166],
      [29.1374431, 40.9902358],
      [29.1393591, 40.9898075],
      [29.1400982, 40.9895441],
      [29.1408857, 40.9885052],
    ],
    // O-4 Otoyol
    o4Otoyol: [
      [29.1318170, 40.9970063],
      [29.1323442, 40.9970425],
      [29.1333863, 40.9970946],
      [29.1344182, 40.9971252],
      [29.1351884, 40.9971176],
      [29.1359451, 40.9970939],
      [29.1370618, 40.9970103],
      [29.1383385, 40.9968808],
      [29.1399079, 40.9966569],
      [29.1411119, 40.9964394],
      [29.1429694, 40.9960883],
      [29.1445290, 40.9957714],
      [29.1462993, 40.9954394],
      [29.1479515, 40.9951721],
      [29.1491907, 40.9949940],
      [29.1504176, 40.9948763],
      [29.1516445, 40.9947909],
      [29.1527736, 40.9947304],
      [29.1543758, 40.9947090],
      [29.1558111, 40.9947024],
      [29.1568956, 40.9947262],
      [29.1583829, 40.9947183],
      [29.1601881, 40.9947024],
      [29.1617264, 40.9946356],
      [29.1633566, 40.9943551],
      [29.1647573, 40.9941601],
    ],
    // Kozyatağı O-2 Bağlantısı
    kozyatagiO2: [
      [29.1060875, 40.9859485],
      [29.1064201, 40.9861766],
      [29.1077715, 40.9871473],
      [29.1079715, 40.9873139],
      [29.1092796, 40.9883497],
      [29.1111193, 40.9901230],
      [29.1116437, 40.9906878],
      [29.1148046, 40.9945709],
      [29.1167953, 40.9968281],
      [29.1176931, 40.9979765],
      [29.1181759, 40.9986658],
      [29.1185110, 40.9991749],
      [29.1188534, 40.9997065],
      [29.1192318, 41.0003236],
      [29.1195845, 41.0010341],
      [29.1200825, 41.0020539],
      [29.1204581, 41.0029625],
      [29.1208173, 41.0039265],
      [29.1210871, 41.0047894],
      [29.1213116, 41.0056662],
      [29.1214386, 41.0064341],
    ],
    // Necip Fazıl Kısakürek Caddesi
    necipFazilCaddesi: [
      [29.1642424, 41.0131542],
      [29.1642931, 41.0128364],
      [29.1643754, 41.0124065],
      [29.1644103, 41.0122952],
      [29.1645059, 41.0119381],
      [29.1645624, 41.0116280],
      [29.1645807, 41.0113797],
      [29.1645719, 41.0111890],
      [29.1645639, 41.0110661],
      [29.1645424, 41.0109554],
      [29.1644881, 41.0107933],
      [29.1644069, 41.0106432],
      [29.1641915, 41.0102886],
      [29.1641317, 41.0102046],
      [29.1640890, 41.0101500],
      [29.1640056, 41.0100274],
      [29.1633712, 41.0092333],
      [29.1631020, 41.0088963],
      [29.1626454, 41.0082538],
      [29.1626116, 41.0082004],
      [29.1625648, 41.0081355],
      [29.1624928, 41.0080445],
      [29.1617894, 41.0072079],
    ],
    // 1. Boğaz Köprüsü (15 Temmuz Şehitler Köprüsü)
    bogazKoprusu1: [
      [29.0151710, 41.0636896],
      [29.0153359, 41.0630747],
      [29.0157010, 41.0616110],
      [29.0158238, 41.0611439],
      [29.0160363, 41.0604637],
      [29.0161370, 41.0602033],
      [29.0163004, 41.0598456],
      [29.0164014, 41.0596563],
      [29.0165091, 41.0594820],
      [29.0166155, 41.0593077],
      [29.0167175, 41.0591757],
      [29.0168358, 41.0590349],
      [29.0169880, 41.0588640],
      [29.0171355, 41.0587096],
      [29.0173536, 41.0585085],
      [29.0175716, 41.0583323],
      [29.0178689, 41.0581118],
      [29.0181271, 41.0579373],
      [29.0215082, 41.0561771],
      [29.0220520, 41.0558823],
      [29.0226608, 41.0555233],
      [29.0237714, 41.0549002],
      [29.0244690, 41.0544912],
      [29.0248100, 41.0542844],
      [29.0252597, 41.0540017],
      [29.0256112, 41.0537601],
      [29.0259398, 41.0535233],
      [29.0262565, 41.0532857],
      [29.0265098, 41.0530775],
      [29.0266817, 41.0529286],
      [29.0270196, 41.0526304],
      [29.0273437, 41.0523425],
      [29.0277806, 41.0519285],
      [29.0282317, 41.0514904],
      [29.0287188, 41.0510170],
      [29.0286101, 41.0509499],
      [29.0289471, 41.0506322],
      [29.0305053, 41.0493357],
      [29.0383486, 41.0418118],
      [29.0384104, 41.0415670],
      [29.0392628, 41.0409211],
      [29.0400517, 41.0399594],
      [29.0401723, 41.0400268],
      [29.0404015, 41.0396147],
      [29.0410787, 41.0389345],
      [29.0418999, 41.0381654],
    ],
    // 2. Boğaz Köprüsü (Fatih Sultan Mehmet Köprüsü)
    bogazKoprusu2: [
      [29.0173889, 41.0960644],
      [29.0178439, 41.0959140],
      [29.0183486, 41.0957442],
      [29.0188396, 41.0955821],
      [29.0193423, 41.0954112],
      [29.0203751, 41.0950583],
      [29.0219778, 41.0945281],
      [29.0354562, 41.0915314],
      [29.0363612, 41.0914088],
      [29.0369777, 41.0913365],
      [29.0376854, 41.0912568],
      [29.0383622, 41.0911851],
      [29.0391683, 41.0911075],
      [29.0399541, 41.0910390],
      [29.0415378, 41.0909385],
      [29.0422298, 41.0908973],
      [29.0431220, 41.0908612],
      [29.0437227, 41.0908386],
      [29.0460056, 41.0907848],
      [29.0464759, 41.0907915],
      [29.0473297, 41.0907983],
      [29.0481592, 41.0908198],
      [29.0488551, 41.0908518],
      [29.0506096, 41.0909197],
      [29.0515322, 41.0909457],
      [29.0524543, 41.0909808],
      [29.0542638, 41.0910620],
      [29.0542772, 41.0909110],
      [29.0680711, 41.0915457],
      [29.0683033, 41.0915600],
      [29.0690881, 41.0916037],
      [29.0706815, 41.0916724],
      [29.0727951, 41.0917532],
      [29.0759878, 41.0919030],
      [29.0801539, 41.0920669],
      [29.0813205, 41.0921118],
      [29.0828366, 41.0920907],
      [29.0833170, 41.0920669],
      [29.0839247, 41.0920267],
      [29.0843780, 41.0919738],
      [29.0849645, 41.0918799],
      [29.0855107, 41.0917754],
      [29.0859698, 41.0916697],
      [29.0865753, 41.0915054],
      [29.0872528, 41.0912892],
      [29.0878401, 41.0910620],
      [29.0884133, 41.0908081],
    ],
  },

  map: null,
  vehicles: [],
  animationId: null,
  isRunning: false,
  activeVehicles: {},      // Multiple active vehicles: { vehicleId: { popup, refreshInterval, mjpegMode } }
  vehiclePositions: {},    // Current positions cache
  lastFrameTime: 0,        // For delta time calculation
  targetFrameTime: 1000 / 60, // Target 60 FPS (16.67ms per frame)

  // Car icon variants
  carIcons: ['car.png', 'car1.png', 'car2.png', 'car3.png', 'car4.png', 'car5.png'],
  truckIcon: 'kamyon.png',

  // Default vehicles with plates
  defaultVehicles: [
    { id: 'v1', plate: '34 ABC 123', route: 'atasehirBulvari', baseSpeed: 0.00018, iconIndex: 0 },
    { id: 'v2', plate: '34 RST 999', route: 'atasehirBulvari', baseSpeed: 0.00021, direction: -1, iconIndex: 3 },
    { id: 'v3', plate: '34 XYZ 456', route: 'o4Otoyol', baseSpeed: 0.00036, iconIndex: 1 },
    { id: 'v4', plate: '34 KLM 789', route: 'o4Otoyol', baseSpeed: 0.0003, direction: -1, iconIndex: 2 },
    { id: 'v5', plate: '06 DEF 012', route: 'o4Otoyol', baseSpeed: 0.00033, iconIndex: 3 },
    { id: 'v6', plate: '34 TRK 567', route: 'kozyatagiO2', baseSpeed: 0.00027, iconIndex: 0 },
    { id: 'v7', plate: '34 PRN 890', route: 'kozyatagiO2', baseSpeed: 0.0003, direction: -1, iconIndex: 2 },
    { id: 'v8', plate: '41 KCL 234', route: 'kozyatagiO2', baseSpeed: 0.00033, iconIndex: 1 },
    { id: 'v12', plate: '34 BGZ 001', route: 'bogazKoprusu1', baseSpeed: 0.00036, iconIndex: 0 },
    { id: 'v13', plate: '34 BGZ 002', route: 'bogazKoprusu1', baseSpeed: 0.00033, direction: -1, iconIndex: 1 },
    { id: 'v14', plate: '06 BGZ 003', route: 'bogazKoprusu1', baseSpeed: 0.00039, iconIndex: 2 },
    { id: 'v15', plate: '34 FSM 001', route: 'bogazKoprusu2', baseSpeed: 0.00042, iconIndex: 3 },
    { id: 'v16', plate: '34 FSM 002', route: 'bogazKoprusu2', baseSpeed: 0.00039, direction: -1, iconIndex: 0 },
    { id: 'v17', plate: '41 FSM 003', route: 'bogazKoprusu2', baseSpeed: 0.00045, iconIndex: 1 },
  ],

  // Hardcoded video URLs for specific vehicles (araç içi kamera kayıtları)
  getHardcodedVideoUrl: function(vehicleId) {
    var videoMap = {
      'v1': '/videos/car1.mp4',
      'v2': '/videos/car2.mp4',
      'v3': '/videos/car3.mp4'
    };
    return videoMap[vehicleId] || null;
  },

  init: function(map) {
    this.map = map;
    this.loadVehicles();

    var self = this;
    var setup = function() {
      self.addVehicleLayers();
      self.setupClickHandler();
      self.start();
    };

    // Use isStyleLoaded() — map.loaded() returns false while tiles load
    // and the 'load' event won't re-fire, so setup() would never run
    if (map.isStyleLoaded()) {
      setup();
    } else {
      map.on('load', setup);
    }
  },

  loadVehicles: function() {
    var saved = localStorage.getItem('qbitmap_vehicles');
    var customVehicles = [];
    if (saved) { try { customVehicles = JSON.parse(saved); } catch(e) { localStorage.removeItem('qbitmap_vehicles'); } }
    var self = this;

    this.vehicles = this.defaultVehicles.map(function(def) {
      var custom = customVehicles.find(function(c) { return c.id === def.id; }) || {};
      var randomIconIndex = Math.floor(Math.random() * self.carIcons.length);
      return {
        id: def.id,
        plate: custom.plate || def.plate,
        route: def.route,
        baseSpeed: def.baseSpeed,
        direction: def.direction || 1,
        iconIndex: randomIconIndex,
        type: def.type,
        cameraId: custom.cameraId || null,
        progress: Math.random(),
        currentSpeed: def.baseSpeed,
        targetSpeed: def.baseSpeed,
        speedTimer: 0,
        routeLength: 0
      };
    });

    this.vehicles.forEach(function(v) {
      v.routeLength = self.calculateRouteLength(self.routes[v.route]);
    });
  },

  saveVehicles: function() {
    var data = this.vehicles.map(function(v) {
      return { id: v.id, plate: v.plate, cameraId: v.cameraId, whepUrl: v.whepUrl };
    });
    localStorage.setItem('qbitmap_vehicles', JSON.stringify(data));
  },

  createVehiclePopup: function(vehicleId) {
    var existingPopup = document.getElementById('vehicle-popup-' + vehicleId);
    if (existingPopup) return existingPopup;

    var popup = document.createElement('div');
    popup.id = 'vehicle-popup-' + vehicleId;
    popup.className = 'vehicle-popup';
    popup.innerHTML = '<div class="vehicle-popup-header">' +
      '<button class="vehicle-popup-mjpeg" onclick="VehicleAnimation.toggleMjpeg(\'' + vehicleId + '\')" title="MJPEG Stream">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M23 7l-7 5 7 5V7z"></path>' +
          '<rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>' +
        '</svg>' +
      '</button>' +
      '<button class="vehicle-popup-edit" onclick="VehicleAnimation.editVehicle(\'' + vehicleId + '\')" title="Düzenle">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>' +
          '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>' +
        '</svg>' +
      '</button>' +
      '<button class="vehicle-popup-close" onclick="VehicleAnimation.closePopup(\'' + vehicleId + '\')">&times;</button>' +
    '</div>' +
    '<div class="vehicle-popup-camera">' +
      '<span class="vehicle-plate"></span>' +
      '<div class="camera-placeholder">Kamera bağlı değil</div>' +
      '<img class="camera-feed" style="display:none">' +
      '<video class="video-feed" style="display:none" autoplay loop muted playsinline></video>' +
    '</div>';
    document.body.appendChild(popup);
    return popup;
  },

  setupClickHandler: function() {
    var self = this;
    this.map.on('click', 'vehicles', function(e) {
      if (e.features && e.features.length > 0) {
        var vehicleId = e.features[0].properties.id;
        self.showPopup(vehicleId);
      }
    });

    this.map.on('mouseenter', 'vehicles', function() {
      self.map.getCanvas().style.cursor = 'pointer';
    });

    this.map.on('mouseleave', 'vehicles', function() {
      self.map.getCanvas().style.cursor = '';
    });
  },

  showPopup: function(vehicleId) {
    var self = this;
    var vehicle = this.vehicles.find(function(v) { return v.id === vehicleId; });
    if (!vehicle) return;

    // If popup already open for this vehicle, close it (toggle behavior)
    if (this.activeVehicles[vehicleId]) {
      this.closePopup(vehicleId);
      return;
    }

    var popup = this.createVehiclePopup(vehicleId);
    popup.querySelector('.vehicle-plate').textContent = vehicle.plate;

    var cameraPlaceholder = popup.querySelector('.camera-placeholder');
    var cameraFeed = popup.querySelector('.camera-feed');
    var videoFeed = popup.querySelector('.video-feed');
    var refreshInterval = null;

    // Check for video URL first (hardcoded or from vehicle data)
    var videoUrl = vehicle.videoUrl || this.getHardcodedVideoUrl(vehicleId);

    if (videoUrl) {
      // Show video feed
      cameraPlaceholder.style.display = 'none';
      cameraFeed.style.display = 'none';
      videoFeed.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; object-fit:contain; background:#000;';
      videoFeed.src = videoUrl;
      videoFeed.play().catch(function() {});
    } else if (vehicle.whepUrl) {
      // WHEP kamera - WebRTC bağlantısı kur
      cameraPlaceholder.textContent = 'Bağlanıyor...';
      cameraPlaceholder.style.display = 'flex';
      cameraFeed.style.display = 'none';
      videoFeed.style.display = 'none';

      this.startWhepStream(vehicleId, vehicle.whepUrl, videoFeed, cameraPlaceholder);
    } else if (vehicle.cameraId) {
      // Device kamera - frame yükle
      cameraPlaceholder.textContent = 'Yükleniyor...';
      cameraPlaceholder.style.display = 'flex';
      cameraFeed.style.display = 'none';
      videoFeed.style.display = 'none';

      this.loadCameraFrame(vehicle.cameraId, cameraFeed, cameraPlaceholder);

      refreshInterval = setInterval(function() {
        var activeData = self.activeVehicles[vehicleId];
        if (activeData && !activeData.mjpegMode) {
          self.loadCameraFrame(vehicle.cameraId, cameraFeed, cameraPlaceholder);
        }
      }, 3000);
    } else {
      cameraFeed.style.display = 'none';
      videoFeed.style.display = 'none';
      cameraPlaceholder.style.display = 'flex';
      cameraPlaceholder.textContent = 'Kamera bağlı değil';
    }

    this.activeVehicles[vehicleId] = {
      popup: popup,
      refreshInterval: refreshInterval,
      mjpegMode: false
    };

    popup.classList.add('active');
    this.updatePopupPosition(vehicleId);
  },

  loadCameraFrame: function(cameraId, imgElement, placeholder) {
    fetch(QBitmapConfig.api.public + '/cameras/' + cameraId + '/latest')
      .then(function(response) {
        if (!response.ok) throw new Error('No frame');
        return response.json();
      })
      .then(function(data) {
        var frame = data.frame;
        var frameUrl = frame.id === 'cached'
          ? QBitmapConfig.api.public + '/frames/cached?device_id=' + cameraId + '&t=' + Date.now()
          : QBitmapConfig.api.public + '/frames/' + frame.id + '?t=' + Date.now();

        imgElement.onload = function() {
          placeholder.style.display = 'none';
          imgElement.style.display = 'block';
        };

        imgElement.onerror = function() {
          imgElement.style.display = 'none';
          placeholder.style.display = 'flex';
          placeholder.textContent = 'Görüntü alınamıyor';
        };

        imgElement.src = frameUrl;
      })
      .catch(function() {
        imgElement.style.display = 'none';
        placeholder.style.display = 'flex';
        placeholder.textContent = 'Kamera çevrimdışı';
      });
  },

  startWhepStream: function(vehicleId, whepUrl, videoEl, placeholder) {
    var self = this;

    if (!whepUrl || !videoEl) {
      placeholder.textContent = 'WHEP URL bulunamadı';
      return;
    }

    // Create RTCPeerConnection
    var pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // Store peer connection for cleanup
    var activeData = this.activeVehicles[vehicleId];
    if (activeData) {
      activeData.peerConnection = pc;
    }

    // Handle incoming tracks
    pc.ontrack = function(event) {
      console.log('[VehicleWHEP] Got track:', event.track.kind);
      if (event.streams && event.streams[0]) {
        videoEl.srcObject = event.streams[0];
        videoEl.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; object-fit:contain; background:#000;';
        placeholder.style.display = 'none';

        videoEl.play().catch(function(err) {
          console.error('[VehicleWHEP] Play error:', err);
        });
      }
    };

    pc.oniceconnectionstatechange = function() {
      console.log('[VehicleWHEP] ICE state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        placeholder.textContent = 'Bağlantı kesildi';
        placeholder.style.display = 'flex';
        videoEl.style.display = 'none';
      }
    };

    // Add transceiver for receiving video
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // Create offer and send to WHEP server
    pc.createOffer()
      .then(function(offer) {
        return pc.setLocalDescription(offer);
      })
      .then(function() {
        // Use WHEP proxy endpoint with URL as query parameter
        var proxyUrl = QBitmapConfig.api.public + '/whep-proxy?url=' + encodeURIComponent(whepUrl);
        return fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription.sdp
        });
      })
      .then(function(response) {
        if (!response.ok) throw new Error('WHEP proxy failed: ' + response.status);
        return response.text();
      })
      .then(function(answerSdp) {
        if (!answerSdp) throw new Error('No SDP in response');
        return pc.setRemoteDescription(new RTCSessionDescription({
          type: 'answer',
          sdp: answerSdp
        }));
      })
      .then(function() {
        console.log('[VehicleWHEP] Connected successfully');
      })
      .catch(function(error) {
        console.error('[VehicleWHEP] Error:', error);
        placeholder.textContent = 'Bağlantı hatası';
        placeholder.style.display = 'flex';
        videoEl.style.display = 'none';
      });
  },

  closePopup: function(vehicleId) {
    var activeData = this.activeVehicles[vehicleId];
    if (!activeData) return;

    var popup = activeData.popup;

    if (activeData.refreshInterval) {
      clearInterval(activeData.refreshInterval);
    }

    // Close WebRTC connection if exists
    if (activeData.peerConnection) {
      activeData.peerConnection.close();
    }

    var cameraFeed = popup.querySelector('.camera-feed');
    if (cameraFeed) cameraFeed.src = '';

    var videoFeed = popup.querySelector('.video-feed');
    if (videoFeed) {
      videoFeed.pause();
      videoFeed.srcObject = null;
      videoFeed.src = '';
    }

    popup.classList.remove('active');
    setTimeout(function() {
      if (popup.parentNode) {
        popup.parentNode.removeChild(popup);
      }
    }, 300);

    delete this.activeVehicles[vehicleId];
  },

  closeAllPopups: function() {
    var self = this;
    Object.keys(this.activeVehicles).forEach(function(vehicleId) {
      self.closePopup(vehicleId);
    });
  },

  toggleMjpeg: function(vehicleId) {
    var self = this;
    var vehicle = this.vehicles.find(function(v) { return v.id === vehicleId; });
    var activeData = this.activeVehicles[vehicleId];
    if (!vehicle || !vehicle.cameraId || !activeData) return;

    var popup = activeData.popup;
    var mjpegBtn = popup.querySelector('.vehicle-popup-mjpeg');
    var cameraFeed = popup.querySelector('.camera-feed');
    var placeholder = popup.querySelector('.camera-placeholder');

    activeData.mjpegMode = !activeData.mjpegMode;

    if (activeData.mjpegMode) {
      mjpegBtn.classList.add('active');

      if (activeData.refreshInterval) {
        clearInterval(activeData.refreshInterval);
        activeData.refreshInterval = null;
      }

      placeholder.textContent = 'MJPEG bağlanıyor...';
      placeholder.style.display = 'flex';
      cameraFeed.style.display = 'none';

      var retryCount = 0;
      var maxRetries = 10;

      var tryLoadStream = function() {
        cameraFeed.onload = function() {
          placeholder.style.display = 'none';
          cameraFeed.style.display = 'block';
        };

        cameraFeed.onerror = function() {
          retryCount++;
          var currentData = self.activeVehicles[vehicleId];
          if (retryCount < maxRetries && currentData && currentData.mjpegMode) {
            setTimeout(tryLoadStream, 1000);
          } else {
            placeholder.textContent = 'MJPEG bağlanamadı';
            placeholder.style.display = 'flex';
            cameraFeed.style.display = 'none';
          }
        };

        cameraFeed.src = QBitmapConfig.api.public + '/stream/' + vehicle.cameraId + '?t=' + Date.now();
      };

      setTimeout(tryLoadStream, 500);
    } else {
      mjpegBtn.classList.remove('active');
      cameraFeed.src = '';

      this.loadCameraFrame(vehicle.cameraId, cameraFeed, placeholder);

      activeData.refreshInterval = setInterval(function() {
        var currentData = self.activeVehicles[vehicleId];
        if (currentData && !currentData.mjpegMode) {
          self.loadCameraFrame(vehicle.cameraId, cameraFeed, placeholder);
        }
      }, 3000);
    }
  },

  updatePopupPosition: function(vehicleId) {
    var activeData = this.activeVehicles[vehicleId];
    if (!activeData) return;

    var pos = this.vehiclePositions[vehicleId];
    if (!pos) return;

    var popup = activeData.popup;
    var point = this.map.project(pos);

    popup.style.left = point.x + 'px';
    popup.style.top = (point.y - 20) + 'px';
  },

  updateAllPopupPositions: function() {
    var self = this;
    Object.keys(this.activeVehicles).forEach(function(vehicleId) {
      self.updatePopupPosition(vehicleId);
    });
  },

  editVehicle: function(vehicleId) {
    var vehicle = this.vehicles.find(function(v) { return v.id === vehicleId; });
    if (!vehicle) return;

    var modal = document.createElement('div');
    modal.id = 'vehicle-edit-modal';
    modal.className = 'vehicle-edit-modal active';
    modal.innerHTML = '<div class="modal-overlay" onclick="VehicleAnimation.closeEditModal()"></div>' +
      '<div class="modal-content">' +
        '<h3>Araç Düzenle</h3>' +
        '<div class="form-group">' +
          '<label>Plaka</label>' +
          '<input type="text" id="edit-plate" value="' + escapeHtml(vehicle.plate) + '" placeholder="34 ABC 123">' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Kamera (opsiyonel)</label>' +
          '<div id="camera-dropdown-container">' +
            '<div class="camera-loading">Kameralar yükleniyor...</div>' +
          '</div>' +
        '</div>' +
        '<input type="hidden" id="edit-vehicle-id" value="' + escapeHtml(vehicleId) + '">' +
        '<div class="modal-actions">' +
          '<button class="btn-secondary" onclick="VehicleAnimation.closeEditModal()">İptal</button>' +
          '<button class="btn-primary" onclick="VehicleAnimation.saveVehicleEdit()">Kaydet</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    // Async olarak WHEP kameraları yükle
    this.loadWhepCamerasDropdown(vehicle.cameraId);
  },

  loadWhepCamerasDropdown: function(selectedCameraId) {
    var container = document.getElementById('camera-dropdown-container');
    if (!container) return;

    // Auth kontrolü
    if (!AuthSystem.isLoggedIn()) {
      container.innerHTML = '<div class="camera-auth-warning">' +
        '<span>Kamera seçmek için giriş yapın</span>' +
        '<button class="btn-secondary btn-sm" onclick="VehicleAnimation.closeEditModal(); AuthSystem.login();">Giriş Yap</button>' +
      '</div>';
      return;
    }

    // WHEP kameraları çek
    fetch(QBitmapConfig.api.users + '/me/cameras', { credentials: 'include' })
      .then(function(response) {
        if (!response.ok) throw new Error('Failed to load cameras');
        return response.json();
      })
      .then(function(data) {
        var cameras = data.cameras || [];
        var whepCameras = cameras.filter(function(cam) {
          return cam.camera_type === 'whep';
        });

        var html = '<select id="edit-camera-id">';
        html += '<option value="">Kamera seçmeyin</option>';

        whepCameras.forEach(function(cam) {
          var selected = cam.device_id === selectedCameraId ? ' selected' : '';
          html += '<option value="' + escapeHtml(cam.device_id) + '" data-whep-url="' + escapeHtml(cam.whep_url || '') + '"' + selected + '>' +
            escapeHtml(cam.name || cam.device_id) + '</option>';
        });
        html += '</select>';

        if (whepCameras.length === 0) {
          html += '<small>Henüz IP kameranız yok</small>';
        } else {
          html += '<small>IP/RTSP kameralarınız listelenir</small>';
        }

        container.innerHTML = html;
      })
      .catch(function(error) {
        console.error('[VehicleEdit] Camera load error:', error);
        container.innerHTML = '<div class="camera-error">Kameralar yüklenemedi</div>';
      });
  },

  closeEditModal: function() {
    var modal = document.getElementById('vehicle-edit-modal');
    if (modal) modal.remove();
  },

  saveVehicleEdit: function() {
    var vehicleId = document.getElementById('edit-vehicle-id').value;
    var vehicle = this.vehicles.find(function(v) { return v.id === vehicleId; });
    if (!vehicle) return;

    var plate = document.getElementById('edit-plate').value.trim();
    var selectEl = document.getElementById('edit-camera-id');
    var cameraId = selectEl.value.trim() || null;
    var whepUrl = null;

    // Seçili option'dan whep_url'i al
    if (selectEl.selectedIndex > 0) {
      var selectedOption = selectEl.options[selectEl.selectedIndex];
      whepUrl = selectedOption.getAttribute('data-whep-url') || null;
    }

    vehicle.plate = plate;
    vehicle.cameraId = cameraId;
    vehicle.whepUrl = whepUrl;

    this.saveVehicles();
    this.closeEditModal();

    if (this.activeVehicles[vehicleId]) {
      this.closePopup(vehicleId);
      this.showPopup(vehicleId);
    }
  },

  calculateRouteLength: function(coords) {
    var length = 0;
    for (var i = 0; i < coords.length - 1; i++) {
      length += this.haversineDistance(coords[i], coords[i + 1]);
    }
    return length;
  },

  haversineDistance: function(c1, c2) {
    var R = 6371;
    var dLat = (c2[1] - c1[1]) * Math.PI / 180;
    var dLon = (c2[0] - c1[0]) * Math.PI / 180;
    var lat1 = c1[1] * Math.PI / 180;
    var lat2 = c2[1] * Math.PI / 180;
    var a = Math.pow(Math.sin(dLat/2), 2) + Math.pow(Math.sin(dLon/2), 2) * Math.cos(lat1) * Math.cos(lat2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  },

  getPointAlongRoute: function(coords, routeLength, progress) {
    var targetDist = progress * routeLength;
    var acc = 0;
    for (var i = 0; i < coords.length - 1; i++) {
      var segDist = this.haversineDistance(coords[i], coords[i + 1]);
      if (acc + segDist >= targetDist) {
        var t = (targetDist - acc) / segDist;
        return [
          coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
          coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t
        ];
      }
      acc += segDist;
    }
    return coords[coords.length - 1];
  },

  calculateBearing: function(start, end) {
    var toRad = function(x) { return x * Math.PI / 180; };
    var dLng = toRad(end[0] - start[0]);
    var lat1 = toRad(start[1]);
    var lat2 = toRad(end[1]);
    var x = Math.sin(dLng) * Math.cos(lat2);
    var y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
  },

  addVehicleLayers: function() {
    var self = this;
    var totalIcons = this.carIcons.length + 1;
    var loadedCount = 0;

    var checkAllLoaded = function() {
      loadedCount++;
      if (loadedCount === totalIcons) {
        self.addVehicleSource();
      }
    };

    this.carIcons.forEach(function(iconFile, index) {
      var img = new Image();
      img.onload = function() {
        var iconName = 'vehicle-icon-' + index;
        if (!self.map.hasImage(iconName)) {
          self.map.addImage(iconName, img);
        }
        checkAllLoaded();
      };
      img.onerror = function() {
        checkAllLoaded();
      };
      img.src = '/' + iconFile;
    });

    var truckImg = new Image();
    truckImg.onload = function() {
      if (!self.map.hasImage('truck-icon')) {
        self.map.addImage('truck-icon', truckImg);
      }
      checkAllLoaded();
    };
    truckImg.onerror = function() {
      checkAllLoaded();
    };
    truckImg.src = '/' + this.truckIcon;
  },

  addVehicleSource: function() {
    var self = this;
    var features = this.vehicles.map(function(v) {
      var coords = self.routes[v.route];
      var pos = self.getPointAlongRoute(coords, v.routeLength, v.progress);
      self.vehiclePositions[v.id] = pos;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: {
          id: v.id,
          plate: v.plate,
          bearing: 0,
          iconIndex: v.iconIndex,
          vehicleType: v.type || 'car'
        }
      };
    });

    if (!this.map.getSource('vehicles')) {
      this.map.addSource('vehicles', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: features }
      });
    }

    if (!this.map.getLayer('vehicles')) {
      var vis = window.vehiclesVisible ? 'visible' : 'none';
      this.map.addLayer({
        id: 'vehicles',
        type: 'symbol',
        source: 'vehicles',
        minzoom: 14,
        maxzoom: 17,
        layout: {
          'visibility': vis,
          'icon-image': [
            'case',
            ['==', ['get', 'vehicleType'], 'truck'], 'truck-icon',
            ['concat', 'vehicle-icon-', ['to-string', ['get', 'iconIndex']]]
          ],
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            14, 0.25,
            17, 0.5
          ],
          'icon-allow-overlap': true,
          'icon-rotate': ['-', ['get', 'bearing'], 90],
          'icon-rotation-alignment': 'map'
        }
      });
    }
  },

  updateVehicleSpeed: function(v, deltaMultiplier) {
    // speedTimer is frame-rate dependent, so multiply by deltaMultiplier
    v.speedTimer += deltaMultiplier;
    if (v.speedTimer > 60 + Math.random() * 120) {
      v.speedTimer = 0;
      if (Math.random() < 0.03) {
        v.targetSpeed = v.baseSpeed * 0.1;
      } else {
        v.targetSpeed = v.baseSpeed * (0.4 + Math.random() * 1.0);
      }
    }
    // Easing factor also needs to be multiplied by deltaMultiplier
    v.currentSpeed += (v.targetSpeed - v.currentSpeed) * 0.02 * deltaMultiplier;
  },

  animate: function(currentTime) {
    if (!this.isRunning) return;

    // Calculate delta time for frame-rate independent animation
    if (!currentTime) currentTime = performance.now();
    var deltaTime = this.lastFrameTime ? (currentTime - this.lastFrameTime) : this.targetFrameTime;
    this.lastFrameTime = currentTime;

    // Clamp delta to prevent huge jumps (e.g., when tab was inactive)
    deltaTime = Math.min(deltaTime, 100);

    // Calculate multiplier: 1.0 at 60fps, 0.5 at 120fps, 2.0 at 30fps
    var deltaMultiplier = deltaTime / this.targetFrameTime;

    var self = this;
    var features = this.vehicles.map(function(v) {
      self.updateVehicleSpeed(v, deltaMultiplier);
      v.progress += v.currentSpeed * v.direction * deltaMultiplier;

      if (v.progress >= 1) { v.progress = 1; v.direction = -1; }
      else if (v.progress <= 0) { v.progress = 0; v.direction = 1; }

      var coords = self.routes[v.route];
      var pos = self.getPointAlongRoute(coords, v.routeLength, v.progress);
      var prevPos = self.getPointAlongRoute(coords, v.routeLength, Math.max(0, v.progress - 0.01));
      var nextPos = self.getPointAlongRoute(coords, v.routeLength, Math.min(1, v.progress + 0.01));
      var bearing = self.calculateBearing(prevPos, nextPos);
      if (v.direction === -1) bearing = (bearing + 180) % 360;

      self.vehiclePositions[v.id] = pos;

      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: {
          id: v.id,
          plate: v.plate,
          bearing: bearing,
          iconIndex: v.iconIndex || 0,
          vehicleType: v.type || 'car'
        }
      };
    });

    var source = this.map.getSource('vehicles');
    if (source) {
      source.setData({ type: 'FeatureCollection', features: features });
    }

    this.updateAllPopupPositions();

    this.animationId = requestAnimationFrame(function(time) { self.animate(time); });
  },

  start: function() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastFrameTime = 0; // Reset for clean start
    this.animate();
  },

  stop: function() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }
};

export { VehicleAnimation };
window.VehicleAnimation = VehicleAnimation;

// Initialize
(function initVehicleAnimation() {
  if (window.map) {
    VehicleAnimation.init(window.map);
  } else {
    setTimeout(initVehicleAnimation, 200);
  }
})();
