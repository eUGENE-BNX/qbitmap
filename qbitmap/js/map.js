import { QBitmapConfig } from './config.js';
import { Logger } from './utils.js';
import { Analytics } from './analytics.js';
import { addLabels } from './labels.js';
import { H3Grid } from './h3-grid.js';
import { H3TronTrails } from './h3-tron-trails.js';
import { CameraSystem } from './camera-system/index.js';
import { setMap, layers, satelliteMode, setSatelliteMode } from './state.js';

// Global unhandled promise rejection handler for video play errors
window.addEventListener('unhandledrejection', (event) => {
    if (event.reason && event.reason.name === 'AbortError') {
        event.preventDefault(); // Suppress AbortError from video play/pause
    }
});



const sourceId = "protomaps";
const baseLayers = basemaps.layers(sourceId, basemaps.LIGHT || basemaps.namedTheme("light"));

// Fix font stack for protomaps (only Noto Sans fonts available)
const sanitizedLayers = baseLayers.map(layer => {
        if (layer.type === "symbol" && layer.layout && layer.layout["text-font"]) {
            return { ...layer, layout: { ...layer.layout, "text-font": ["Noto Sans Medium"] } };
        }
        return layer;
    });

const style = {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/light",
    sources: {
        [sourceId]: { type: "vector", url: `${location.origin}/tiles/20260331.json` },
        "atasehir-satellite": {
            type: "raster",
            url: "https://qbitmap.com/tiles/Atasehir.json",
            tileSize: 256,
            bounds: [29.0896, 40.9724, 29.1584, 41.0095],
            minzoom: 17,
            maxzoom: 18
        },
        "sincan-satellite": {
            type: "raster",
            url: "https://qbitmap.com/tiles/Sincan02.json",
            tileSize: 256,
            bounds: [32.5483, 39.9492, 32.6114, 39.9837],
            minzoom: 17,
            maxzoom: 18
        }
    },
    layers: sanitizedLayers
};

// Determine initial center/zoom: localStorage > default
// Note: hash:true means MapLibre persists position in URL hash between sessions.
// If user has a saved geolocation, clear stale hash so our center takes effect.
function getInitialView() {
    const saved = localStorage.getItem('qbitmap_user_location');
    if (saved) {
        try {
            const { lng, lat } = JSON.parse(saved);
            history.replaceState(null, '', location.pathname);
            return { center: [lng, lat], zoom: 12 };
        } catch {}
    }
    return { center: QBitmapConfig.map.defaultCenter, zoom: QBitmapConfig.map.defaultZoom };
}

const initialView = getInitialView();

const map = new maplibregl.Map({
    container: "map",
    style,
    center: initialView.center,
    zoom: initialView.zoom,
    minZoom: QBitmapConfig.map.minZoom,
    maxZoom: QBitmapConfig.map.maxZoom,
    pitch: 0,
    bearing: 0,
    maxPitch: 60,
    hash: true,
    attributionControl: false,
    canvasContextAttributes: {
        failIfMajorPerformanceCaveat: false
    }
});

setMap(map);
let _satelliteMode = false;
let updateSatelliteVisibility;
let videoBounds;
Logger.log("[Map] Map instance created");

// Request geolocation, save to localStorage, fly on first visit
if (navigator.geolocation) {
    const hadLocation = localStorage.getItem('qbitmap_user_location');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const loc = { lng: pos.coords.longitude, lat: pos.coords.latitude };
            localStorage.setItem('qbitmap_user_location', JSON.stringify(loc));
            if (!hadLocation) {
                map.flyTo({ center: [loc.lng, loc.lat], zoom: 12 });
            }
        },
        () => {},
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
}

map.on("error", (e) => Logger.error("[Map] Error:", e.error));

map.addControl(new maplibregl.FullscreenControl({container: document.body}), "top-right");
map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), "top-right");


// Layers Dropdown Control - combines satellite, video, 3D objects, 3D buildings
class LayersDropdownControl {
    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group layers-dropdown-wrapper';

        this._button = document.createElement('button');
        this._button.className = 'satellite-toggle-btn';
        this._button.type = 'button';
        this._button.title = 'Katmanlar';
        this._button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 4L4 8l8 4 8-4-8-4z"/><path d="M4 12l8 4 8-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16l8 4 8-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

        this._dropdown = document.createElement('div');
        this._dropdown.className = 'layers-dropdown';

        const items = [
            { id: 'h3-grid', label: 'Qbitmap' },
            { id: 'h3-trails', label: 'Qbit Search' },
            { id: 'city-cameras', label: 'Şehir Kameraları' },
            { id: 'user-cameras', label: 'Kameralar' },
            { id: 'video-messages', label: 'Video Mesajlar' },
            { id: 'photo-messages', label: 'Resim Mesajlar' },
            { id: 'satellite', label: 'Uydu Görüntüleri' },
            { id: 'video', label: 'Canlı Uydu Görüntüleri' },
            { id: '3d-buildings', label: '3D Binalar' },
            { id: 'vehicles', label: 'Online Araçlar' }
        ];

        this._toggles = {};

        items.forEach(item => {
            const row = document.createElement('div');
            row.className = 'layers-dropdown-item';

            const label = document.createElement('span');
            label.className = 'layers-dropdown-label';
            label.textContent = item.label;

            const toggle = document.createElement('div');
            toggle.className = 'layers-toggle';
            const knob = document.createElement('div');
            knob.className = 'layers-toggle-knob';
            toggle.appendChild(knob);

            this._toggles[item.id] = toggle;

            // Set initial active state for default-on layers
            if (['video-messages', 'photo-messages', 'city-cameras', 'user-cameras'].includes(item.id)) {
                toggle.classList.add('active');
            }

            row.appendChild(label);

            // Add upload button for Vehicles row
            if (item.id === 'vehicles') {
                const uploadBtn = document.createElement('button');
                uploadBtn.className = 'tesla-upload-btn';
                uploadBtn.title = 'Tesla Dashcam Yükle';
                uploadBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
                uploadBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!window.TeslaDashcam) {
                        await import('/js/tesla-dashcam.js');
                    }
                    if (window.TeslaDashcam) {
                        if (!TeslaDashcam.map) TeslaDashcam.init(map);
                        TeslaDashcam.showUploadDialog();
                    }
                });
                row.appendChild(uploadBtn);
            }

            row.appendChild(toggle);
            row.addEventListener('click', () => this._toggleLayer(item.id));
            this._dropdown.appendChild(row);
        });

        this._button.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleDropdown();
        });

        this._outsideClickHandler = (e) => {
            if (!this._container.contains(e.target)) {
                this._closeDropdown();
            }
        };
        document.addEventListener('click', this._outsideClickHandler);

        this._container.appendChild(this._button);
        this._container.appendChild(this._dropdown);
        return this._container;
    }

    _toggleDropdown() {
        this._dropdown.classList.toggle('open');
    }

    _closeDropdown() {
        this._dropdown.classList.remove('open');
    }

    _toggleLayer(layerId) {
        Analytics.event('map_layer_change', { layer_name: layerId });
        const toggle = this._toggles[layerId];
        switch (layerId) {
            case 'satellite':
                _satelliteMode = !_satelliteMode;
                toggle.classList.toggle('active', _satelliteMode);
                if (updateSatelliteVisibility) updateSatelliteVisibility();
                if (_satelliteMode && !this._isInSatelliteArea()) {
                    this._showToast('Uydu g\u00F6r\u00FCnt\u00FCleri \u015Fu an yaln\u0131zca Ata\u015Fehir ve Sincan b\u00F6lgelerinde kullan\u0131labilir');
                }
                break;
            case 'video':
                _videoLayerVisible = !_videoLayerVisible;
                toggle.classList.toggle('active', _videoLayerVisible);
                if (this._map.getLayer('video-layer')) {
                    this._map.setLayoutProperty('video-layer', 'visibility', _videoLayerVisible ? 'visible' : 'none');
                }
                const currentZoom = this._map.getZoom();
                if (_videoLayerVisible && currentZoom >= 18.4 && videoBounds) {
                    this._map.setMaxBounds(videoBounds);
                } else {
                    this._map.setMaxBounds(null);
                }
                if (_videoLayerVisible && !this._isInVideoArea()) {
                    this._showToast('Canl\u0131 video \u015Fu an yaln\u0131zca Ata\u015Fehir b\u00F6lgesinde kullan\u0131labilir');
                }
                break;
            case '3d-buildings':
                _buildings3DVisible = !_buildings3DVisible;
                toggle.classList.toggle('active', _buildings3DVisible);
                if (this._map.getLayer('3d-buildings')) {
                    this._map.setLayoutProperty('3d-buildings', 'visibility', _buildings3DVisible ? 'visible' : 'none');
                }
                break;
            case 'h3-grid':
                layers.h3GridVisible = !layers.h3GridVisible;
                localStorage.setItem('qbitmap_h3grid', layers.h3GridVisible);
                toggle.classList.toggle('active', layers.h3GridVisible);
                H3Grid.setEnabled(layers.h3GridVisible);
                break;
            case 'h3-trails':
                layers.h3TrailsVisible = !layers.h3TrailsVisible;
                toggle.classList.toggle('active', layers.h3TrailsVisible);
                H3TronTrails.setEnabled(layers.h3TrailsVisible);
                break;
            case 'vehicles':
                layers.vehiclesVisible = !layers.vehiclesVisible;
                toggle.classList.toggle('active', layers.vehiclesVisible);
                if (layers.vehiclesVisible) {
                    if (this._map.getLayer('vehicles')) this._map.setLayoutProperty('vehicles', 'visibility', 'visible');
                    if (window.VehicleAnimation) {
                        VehicleAnimation.start();
                    } else {
                        import('/js/vehicle-animation/index.js').then(() => {
                            if (window.VehicleAnimation) VehicleAnimation.start();
                        });
                    }
                    // Fly to Ataşehir where vehicles are (layer minzoom:14, maxzoom:17)
                    const zoom = this._map.getZoom();
                    const center = this._map.getCenter();
                    const inVehicleArea = center.lat > 40.9 && center.lat < 41.1 && center.lng > 28.9 && center.lng < 29.2;
                    if (!inVehicleArea || zoom < 14 || zoom > 17) {
                        this._map.flyTo({ center: [29.114, 40.997], zoom: 15 });
                    }
                } else {
                    if (this._map.getLayer('vehicles')) this._map.setLayoutProperty('vehicles', 'visibility', 'none');
                    if (window.VehicleAnimation) VehicleAnimation.stop();
                }
                break;
            case 'city-cameras':
                layers.cityCamerasVisible = !layers.cityCamerasVisible;
                toggle.classList.toggle('active', layers.cityCamerasVisible);
                if (CameraSystem) CameraSystem.updateCameraFilter();
                break;
            case 'user-cameras':
                layers.userCamerasVisible = !layers.userCamerasVisible;
                toggle.classList.toggle('active', layers.userCamerasVisible);
                if (CameraSystem) CameraSystem.updateCameraFilter();
                break;
            case 'video-messages':
                _videoMessagesVisible = !_videoMessagesVisible;
                toggle.classList.toggle('active', _videoMessagesVisible);
                ['video-messages', 'video-message-clusters', 'video-message-cluster-count'].forEach(id => {
                    if (this._map.getLayer(id)) this._map.setLayoutProperty(id, 'visibility', _videoMessagesVisible ? 'visible' : 'none');
                });
                break;
            case 'photo-messages':
                _photoMessagesVisible = !_photoMessagesVisible;
                toggle.classList.toggle('active', _photoMessagesVisible);
                ['photo-messages', 'photo-message-clusters', 'photo-message-cluster-count'].forEach(id => {
                    if (this._map.getLayer(id)) this._map.setLayoutProperty(id, 'visibility', _photoMessagesVisible ? 'visible' : 'none');
                });
                break;
        }
        this._updateButtonState();
    }

    _isInSatelliteArea() {
        const c = this._map.getCenter();
        const inAtasehir = c.lng >= 29.0896 && c.lng <= 29.1584 && c.lat >= 40.9724 && c.lat <= 41.0095;
        const inSincan = c.lng >= 32.5483 && c.lng <= 32.6114 && c.lat >= 39.9492 && c.lat <= 39.9837;
        return inAtasehir || inSincan;
    }

    _isInVideoArea() {
        const c = this._map.getCenter();
        const margin = 0.003;
        return c.lng >= 29.1272993 - 0.00185 - margin && c.lng <= 29.1272993 + 0.00185 + margin &&
               c.lat >= 40.9925979 - 0.00080 - margin && c.lat <= 40.9925979 + 0.00080 + margin;
    }

    _showToast(message) {
        const existing = document.querySelector('.satellite-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'satellite-toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    _updateButtonState() {
        const anyActive = _satelliteMode || _videoLayerVisible || _buildings3DVisible || layers.h3GridVisible || layers.vehiclesVisible || _videoMessagesVisible || _photoMessagesVisible;
        this._button.style.backgroundColor = anyActive ? '#a0a0a0' : '';
        this._button.style.color = anyActive ? '#fff' : '';
    }

    syncToggleState(layerId, state) {
        const toggle = this._toggles[layerId];
        if (toggle) {
            toggle.classList.toggle('active', state);
            this._updateButtonState();
        }
    }

    onRemove() {
        document.removeEventListener('click', this._outsideClickHandler);
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
    }
}

const layersControl = new LayersDropdownControl();
map.addControl(layersControl, 'top-right');

let _videoLayerVisible = false;
let _buildings3DVisible = false;
let _videoMessagesVisible = true;
let _photoMessagesVisible = true;

// Logo click → toggle H3 Grid (Qbitmap layer)
document.addEventListener('DOMContentLoaded', () => {
    const logo = document.querySelector('.qbitmap-logo-control');
    if (logo) {
        logo.style.cursor = 'pointer';
        logo.addEventListener('click', () => {
            layers.h3GridVisible = !layers.h3GridVisible;
            localStorage.setItem('qbitmap_h3grid', layers.h3GridVisible);
            H3Grid.setEnabled(layers.h3GridVisible);
            if (layersControl) layersControl.syncToggleState('h3-grid', layers.h3GridVisible);
            Analytics.event('map_layer_change', { layer_name: 'h3-grid' });
        });
    }
});

// Camera Grid Control - Toggle 3x2 camera grid overlay
class GridCameraControl {
    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

        this._button = document.createElement('button');
        this._button.className = 'satellite-toggle-btn grid-camera-btn';
        this._button.type = 'button';
        this._button.title = 'Kamera Izgarasi';
        this._button.innerHTML = this._getGridIcon();

        this._button.addEventListener('click', () => this._toggleGrid());
        this._container.appendChild(this._button);

        // Store reference for CameraSystem
        if (CameraSystem) {
            CameraSystem.gridControlButton = this._button;
        }

        return this._container;
    }

    _getGridIcon() {
        return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>`;
    }

    _toggleGrid() {
        if (CameraSystem && CameraSystem.toggleGrid) {
            // Ensure button reference is stored
            CameraSystem.gridControlButton = this._button;
            CameraSystem.toggleGrid();
        } else {
            console.warn('[GridCameraControl] CameraSystem not available');
        }
    }

    onRemove() {
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
    }
}

map.addControl(new GridCameraControl(), 'top-right');

map.on("load", async () => {
    Logger.log("[Map] loaded");

    // Initialize H3 Grid layer
    await H3Grid.init(map);
    H3TronTrails.init(map);

    // Restore persisted layer states
    if (layers.h3GridVisible) {
        H3Grid.setEnabled(true);
        if (layersControl) layersControl.syncToggleState('h3-grid', true);
    }

    // Lazy-load non-critical modules after map is ready
    import('/js/tesla-dashcam.js');

    const styleObj = map.getStyle();
    const vectorSourceId = Object.entries(styleObj.sources).find(([, src]) => src.type === "vector")?.[0];
    if (!vectorSourceId) return;

    const insertBefore = styleObj.layers.find(l => l.type === 'line' || l.type === 'symbol')?.id || undefined;

    map.addLayer({
        id: "atasehir-satellite-layer",
        type: "raster",
        source: "atasehir-satellite",
        minzoom: 17,
        maxzoom: 19,
        layout: { visibility: 'none' },
        paint: { "raster-opacity": 1 }
    }, insertBefore);

    map.addLayer({
        id: "sincan-satellite-layer",
        type: "raster",
        source: "sincan-satellite",
        minzoom: 17,
        maxzoom: 19,
        layout: { visibility: 'none' },
        paint: { "raster-opacity": 1 }
    }, insertBefore);


    const atasehirBounds = { minLng: 29.0896, maxLng: 29.1584, minLat: 40.9724, maxLat: 41.0095 };
    const sincanBounds = { minLng: 32.5483, maxLng: 32.6114, minLat: 39.9492, maxLat: 39.9837 };

    const layersToHide = styleObj.layers
        .filter(l =>
            l['source-layer'] === 'buildings' ||
            l.id.includes('building') ||
            l['source-layer'] === 'roads' ||
            l.id.includes('road') ||
            l.id.includes('highway') ||
            l['source-layer'] === 'water' ||
            l.id.includes('water') ||
            l.id.includes('lake') ||
            l.id.includes('pool') ||
            l.id.includes('ocean') ||
            l.id.includes('sea')
        )
        .map(l => l.id);

    updateSatelliteVisibility = () => {
        const zoom = map.getZoom();
        const center = map.getCenter();
        
        const inAtasehir = center.lng >= atasehirBounds.minLng && center.lng <= atasehirBounds.maxLng &&
                          center.lat >= atasehirBounds.minLat && center.lat <= atasehirBounds.maxLat;
        const inSincan = center.lng >= sincanBounds.minLng && center.lng <= sincanBounds.maxLng &&
                        center.lat >= sincanBounds.minLat && center.lat <= sincanBounds.maxLat;
        
        const atasehirVisible = _satelliteMode && zoom >= 17 && zoom < 19 && inAtasehir;
        const sincanVisible = _satelliteMode && zoom >= 17 && zoom < 19 && inSincan;
        const satelliteVisible = atasehirVisible || sincanVisible;

        if (map.getLayer('atasehir-satellite-layer')) {
            map.setLayoutProperty('atasehir-satellite-layer', 'visibility', atasehirVisible ? 'visible' : 'none');
        }
        if (map.getLayer('sincan-satellite-layer')) {
            map.setLayoutProperty('sincan-satellite-layer', 'visibility', sincanVisible ? 'visible' : 'none');
        }

        const vectorVisibility = satelliteVisible ? 'none' : 'visible';
        layersToHide.forEach(layerId => {
            if (map.getLayer(layerId)) {
                map.setLayoutProperty(layerId, 'visibility', vectorVisibility);
            }
        });
        if (map.getLayer('3d-buildings')) {
            const showBuildings = !satelliteVisible && _buildings3DVisible;
            map.setLayoutProperty('3d-buildings', 'visibility', showBuildings ? 'visible' : 'none');
        }
    };

    let _satDebounce;
    const debouncedSatUpdate = () => {
        clearTimeout(_satDebounce);
        _satDebounce = setTimeout(updateSatelliteVisibility, 120);
    };
    map.on('moveend', debouncedSatUpdate);
    map.on('zoomend', debouncedSatUpdate);

    const sourceLayer = "buildings";
    const firstLabel = styleObj.layers.find(l => l.type === "symbol")?.id;
    const heightRaw = ["to-number", ["get", "height"]];
    const heightClamped = ["min", ["max", heightRaw, 0], 350];

    const colorExpression = [
        "interpolate", ["linear"], heightClamped,
        0, "#d0d7e2", 20, "#c2c3d3", 40, "#b7b1b0",
        80, "#a38f8a", 150, "#8c7463", 350, "#755b46"
    ];

    const heightFilter = ["all", ["has", "height"], [">", heightRaw, 0], ["<=", heightRaw, 350]];

    if (!map.getLayer('3d-buildings')) {
        map.addLayer({
            id: "3d-buildings",
            type: "fill-extrusion",
            source: vectorSourceId,
            "source-layer": sourceLayer,
            minzoom: 14,
            filter: heightFilter,
            layout: { visibility: 'none' },
            paint: {
                "fill-extrusion-color": colorExpression,
                "fill-extrusion-height": heightClamped,
                "fill-extrusion-base": 0,
                "fill-extrusion-opacity": 0.75,
            },
        }, firstLabel);
    }

    if (typeof addLabels === 'function') {
        addLabels(map, vectorSourceId);
    }

    // Video Layer - Center: 29.1272993, 40.9925979
    // 16:9 aspect ratio (1920x1080), FOV 84deg, 175m altitude (~177m height, ~315m width)
    const videoCenter = [29.1272993, 40.9925979];
    const videoOffset = { lng: 0.00185, lat: 0.00080 };

    const corners = [
        [videoCenter[0] - videoOffset.lng, videoCenter[1] + videoOffset.lat],
        [videoCenter[0] + videoOffset.lng, videoCenter[1] + videoOffset.lat],
        [videoCenter[0] + videoOffset.lng, videoCenter[1] - videoOffset.lat],
        [videoCenter[0] - videoOffset.lng, videoCenter[1] - videoOffset.lat]
    ];

    // Video bounds for pan restriction (SW, NE corners)
    // Stored on window for access from VideoLayerToggleControl
    videoBounds = [
        [videoCenter[0] - videoOffset.lng, videoCenter[1] - videoOffset.lat],  // SW
        [videoCenter[0] + videoOffset.lng, videoCenter[1] + videoOffset.lat]   // NE
    ];
    // videoBounds already set above as module-scoped let

    map.addSource('video-source', {
        type: 'video',
        urls: ['/videos/a1.mp4?v=20251215'],
        coordinates: corners
    });

    map.addLayer({
        id: 'video-layer',
        type: 'raster',
        source: 'video-source',
        minzoom: 18.4,
        paint: {
            'raster-opacity': 0
        }
    });

    // Video fade state
    let videoFadeAnimation = null;
    let videoVisible = false;

    // Helper to check if point is near video bounds
    const isNearVideoBounds = (center) => {
        const margin = 0.005; // ~500m margin
        return center.lng >= videoBounds[0][0] - margin &&
               center.lng <= videoBounds[1][0] + margin &&
               center.lat >= videoBounds[0][1] - margin &&
               center.lat <= videoBounds[1][1] + margin;
    };

    // Video visibility handler - checks zoom and location
    const updateVideoVisibility = () => {
        const videoSource = map.getSource('video-source');
        const currentZoom = map.getZoom();
        const center = map.getCenter();
        const nearVideo = isNearVideoBounds(center);
        const shouldShow = currentZoom >= 18.4 && nearVideo && _videoLayerVisible;

        // Pan restriction: only when zoomed in AND near video area
        if (shouldShow) {
            if (!map.getMaxBounds()) {
                map.setMaxBounds(videoBounds);
            }
        } else {
            if (map.getMaxBounds()) {
                map.setMaxBounds(null);
            }
        }

        if (videoSource) {
            if (shouldShow && !videoVisible) {
                // Fade in
                videoVisible = true;
                try {
                    const playPromise = videoSource.play();
                    if (playPromise !== undefined && playPromise.catch) {
                        playPromise.catch(() => {});
                    }
                } catch (e) {}

                // Animate opacity from 0 to 1
                if (videoFadeAnimation) cancelAnimationFrame(videoFadeAnimation);
                let opacity = map.getPaintProperty('video-layer', 'raster-opacity') || 0;
                const fadeIn = () => {
                    opacity = Math.min(1, opacity + 0.09);
                    map.setPaintProperty('video-layer', 'raster-opacity', opacity);
                    if (opacity < 1) {
                        videoFadeAnimation = requestAnimationFrame(fadeIn);
                    }
                };
                fadeIn();

            } else if (!shouldShow && videoVisible) {
                // Fade out
                videoVisible = false;

                // Animate opacity from 1 to 0
                if (videoFadeAnimation) cancelAnimationFrame(videoFadeAnimation);
                let opacity = map.getPaintProperty('video-layer', 'raster-opacity') || 1;
                const fadeOut = () => {
                    opacity = Math.max(0, opacity - 0.09);
                    map.setPaintProperty('video-layer', 'raster-opacity', opacity);
                    if (opacity > 0) {
                        videoFadeAnimation = requestAnimationFrame(fadeOut);
                    } else {
                        videoSource.pause();
                    }
                };
                fadeOut();
            }
        }
    };

    // Listen to both zoom and move events (debounced)
    let _vidDebounce;
    const debouncedVideoUpdate = () => {
        clearTimeout(_vidDebounce);
        _vidDebounce = setTimeout(updateVideoVisibility, 100);
    };
    map.on('zoom', debouncedVideoUpdate);
    map.on('move', debouncedVideoUpdate);

});

