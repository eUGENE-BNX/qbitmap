// Initialize PMTiles protocol
const { PMTiles, Protocol } = window.pmtiles;
const pmtilesUrl = `${location.origin}/maps/tr.pmtiles`;
const atasehirSatelliteUrl = 'https://static.qbitmap.com/maps/Atasehir.pmtiles';
const sincanSatelliteUrl = 'https://static.qbitmap.com/maps/Sincan02.pmtiles';
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// Add both PMTiles sources to protocol
const pmtilesSource = new PMTiles(pmtilesUrl);
const atasehirSource = new PMTiles(atasehirSatelliteUrl);
const sincanSource = new PMTiles(sincanSatelliteUrl);
protocol.add(pmtilesSource);
protocol.add(atasehirSource);
protocol.add(sincanSource);

const sourceId = "protomaps";
const baseLayers = basemaps.layers(sourceId, basemaps.LIGHT);

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
        [sourceId]: { type: "vector", url: `pmtiles://${pmtilesUrl}` },
        "atasehir-satellite": {
            type: "raster",
            url: `pmtiles://${atasehirSatelliteUrl}`,
            tileSize: 256,
            bounds: [29.0896, 40.9724, 29.1584, 41.0095],
            minzoom: 17,
            maxzoom: 18
        },
        "sincan-satellite": {
            type: "raster",
            url: `pmtiles://${sincanSatelliteUrl}`,
            tileSize: 256,
            bounds: [32.5483, 39.9492, 32.6114, 39.9837],
            minzoom: 17,
            maxzoom: 18
        }
    },
    layers: sanitizedLayers
};

// Default view for first-time visitors (no hash in URL)
const defaultCenter = [29.12303, 40.99194];
const defaultZoom = 14.5;

const map = new maplibregl.Map({
    container: "map",
    style,
    center: defaultCenter,
    zoom: defaultZoom,
    pitch: 0,
    bearing: 0,
    maxPitch: 60,
    hash: true,
    attributionControl: true,
    canvasContextAttributes: {
        failIfMajorPerformanceCaveat: false
    }
});

window.map = map;
window.satelliteMode = false;
Logger.log("[Map] Map instance created");

map.on("error", (e) => Logger.error("[Map] Error:", e.error));

map.addControl(new maplibregl.FullscreenControl({container: document.body}), "top-right");
map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), "top-right");


class SatelliteToggleControl {
    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

        this._button = document.createElement('button');
        this._button.className = 'satellite-toggle-btn';
        this._button.type = 'button';
        this._button.title = 'Uydu Görüntüsü';
        this._button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 4L4 8l8 4 8-4-8-4z"/><path d="M4 12l8 4 8-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16l8 4 8-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

        this._button.addEventListener('click', () => this._toggleSatellite());
        this._container.appendChild(this._button);
        return this._container;
    }

    _toggleSatellite() {
        const zoom = this._map.getZoom();
        if (zoom < 17 || zoom >= 19) {
            this._showToast('Uydu görüntüleri sadece 17-18 zoom seviyelerinde kullanılabilir');
            return;
        }
        window.satelliteMode = !window.satelliteMode;
        this._updateStyle(window.satelliteMode);
        if (window.updateSatelliteVisibility) {
            window.updateSatelliteVisibility();
        }
    }

    _updateStyle(active) {
        this._button.style.backgroundColor = active ? '#a0a0a0' : '';
        this._button.style.color = active ? '#fff' : '';
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

    onRemove() {
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
    }
}

map.addControl(new SatelliteToggleControl(), 'top-right');

// Video Layer Toggle Control (L button)
class VideoLayerToggleControl {
    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

        this._button = document.createElement('button');
        this._button.className = 'satellite-toggle-btn';
        this._button.type = 'button';
        this._button.title = 'Video Layer';
        this._button.innerHTML = '<span style="font-size: 12px; font-weight: bold;">L</span>';
        this._updateStyle(false);

        this._button.addEventListener('click', () => this._toggle());
        this._container.appendChild(this._button);
        return this._container;
    }

    _toggle() {
        window.videoLayerVisible = !window.videoLayerVisible;
        this._updateStyle(window.videoLayerVisible);
        if (this._map.getLayer('video-layer')) {
            this._map.setLayoutProperty('video-layer', 'visibility', window.videoLayerVisible ? 'visible' : 'none');
        }
    }

    _updateStyle(active) {
        this._button.style.backgroundColor = active ? '#a0a0a0' : '';
        this._button.style.color = active ? '#fff' : '';
    }

    onRemove() {
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
    }
}

// 3D Object Layer Toggle Control (A button)
class Object3DToggleControl {
    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

        this._button = document.createElement('button');
        this._button.className = 'satellite-toggle-btn';
        this._button.type = 'button';
        this._button.title = '3D Objeler';
        this._button.innerHTML = '<span style="font-size: 12px; font-weight: bold;">A</span>';
        this._updateStyle(false);

        this._button.addEventListener('click', () => this._toggle());
        this._container.appendChild(this._button);
        return this._container;
    }

    _toggle() {
        window.object3DLayerVisible = !window.object3DLayerVisible;
        this._updateStyle(window.object3DLayerVisible);
        const visibility = window.object3DLayerVisible ? 'visible' : 'none';
        if (this._map.getLayer('3d-burger')) {
            this._map.setLayoutProperty('3d-burger', 'visibility', visibility);
        }
        if (this._map.getLayer('3d-moon')) {
            this._map.setLayoutProperty('3d-moon', 'visibility', visibility);
        }
    }

    _updateStyle(active) {
        this._button.style.backgroundColor = active ? '#a0a0a0' : '';
        this._button.style.color = active ? '#fff' : '';
    }

    onRemove() {
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
    }
}

window.videoLayerVisible = false;
window.object3DLayerVisible = false;

map.addControl(new VideoLayerToggleControl(), 'top-right');
map.addControl(new Object3DToggleControl(), 'top-right');

/**
 * Wait for ModelManager to be available
 * @returns {Promise} Resolves when ModelManager is ready
 */
function waitForModelManager() {
  return new Promise((resolve) => {
    if (window.ModelManager) {
      resolve();
    } else {
      const checkInterval = setInterval(() => {
        if (window.ModelManager) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50); // Check every 50ms
    }
  });
}

map.on("load", async () => {
    Logger.log("[Map] loaded");

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

    window.updateSatelliteVisibility = () => {
        const zoom = map.getZoom();
        const center = map.getCenter();
        
        const inAtasehir = center.lng >= atasehirBounds.minLng && center.lng <= atasehirBounds.maxLng &&
                          center.lat >= atasehirBounds.minLat && center.lat <= atasehirBounds.maxLat;
        const inSincan = center.lng >= sincanBounds.minLng && center.lng <= sincanBounds.maxLng &&
                        center.lat >= sincanBounds.minLat && center.lat <= sincanBounds.maxLat;
        
        const atasehirVisible = window.satelliteMode && zoom >= 17 && zoom < 19 && inAtasehir;
        const sincanVisible = window.satelliteMode && zoom >= 17 && zoom < 19 && inSincan;
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
            map.setLayoutProperty('3d-buildings', 'visibility', vectorVisibility);
        }
    };

    map.on('moveend', window.updateSatelliteVisibility);
    map.on('zoomend', window.updateSatelliteVisibility);

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
    // 16:9 aspect ratio (3840x2160), FOV 84deg, 120m altitude (~121m height, ~216m width)
    const videoCenter = [29.1272993, 40.9925979];
    const videoOffset = { lng: 0.001285, lat: 0.000546 };

    const corners = [
        [videoCenter[0] - videoOffset.lng, videoCenter[1] + videoOffset.lat],
        [videoCenter[0] + videoOffset.lng, videoCenter[1] + videoOffset.lat],
        [videoCenter[0] + videoOffset.lng, videoCenter[1] - videoOffset.lat],
        [videoCenter[0] - videoOffset.lng, videoCenter[1] - videoOffset.lat]
    ];

    map.addSource('video-source', {
        type: 'video',
        urls: ['/videos/a1.mp4'],
        coordinates: corners
    });

    map.addLayer({
        id: 'video-layer',
        type: 'raster',
        source: 'video-source',
        minzoom: 19,
        paint: {
            'raster-opacity': 1
        }
    });

    map.on('zoom', () => {
        const videoSource = map.getSource('video-source');
        if (videoSource) {
            if (map.getZoom() >= 18.7) {
                try {
                    const playPromise = videoSource.play();
                    if (playPromise !== undefined && playPromise.catch) {
                        playPromise.catch(() => {});
                    }
                } catch (e) {}
            } else {
                videoSource.pause();
            }
        }
    });

    // Wait for ModelManager before using it
    await waitForModelManager();

    // 3D Model - Burger (rotating)
    ModelManager.addModel(map, {
        id: '3d-burger',
        url: '/3d/burger.glb',
        coordinates: [29.1250457, 40.99394],
        altitude: 25,
        rotation: [Math.PI / 2, 0, 0],
        scale: 30,
        minZoom: 14,
        animate: { axis: 'y', speed: 0.005 },
        popupContent: '<strong>Burger</strong>'
    });

    // 3D Model - Moon
    ModelManager.addModel(map, {
        id: '3d-moon',
        url: '/3d/moon.glb',
        coordinates: [29.12792881, 40.98349139],
        altitude: 3,
        rotation: [Math.PI / 2, 0, 0],
        scale: 45,
        minZoom: 14,
        animate: { axis: 'y', speed: 0.003 },
        popupContent: '<strong>Moon</strong>'
    });
});
