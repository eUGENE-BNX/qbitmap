import { QBitmapConfig } from './config.js';
import { Logger, escapeHtml } from './utils.js';
import { AuthSystem } from './auth.js';
import { CameraSystem } from './camera-system/index.js';
import * as AppState from './state.js';
// [PERF-01] Removed static `import { LiveBroadcast } from './live-broadcast/index.js'`
// — it was never referenced in this file but pulled the ~20KB live-broadcast
// chunk into the main static graph on every page load.
import { LocationService } from './services/location-service.js';

/**
 * UserLocationSystem - Display user's location on map
 * Shows avatar marker with accuracy circle and info popup
 */

const UserLocationSystem = {
    isVisible: false,
    currentPosition: null,
    popup: null,
    hidePopupTimeout: null,
    publicUsersLoaded: false,
    publicMarkers: [], // Store HTML markers for public users

    /**
     * Initialize the system
     */
    init() {
        // Listen for auth events
        window.addEventListener('auth:logout', () => this.hide());

        // Load public user locations when map is ready
        this.waitForMapAndLoadPublicLocations();

        // Load current user's own location if they have showOnMap enabled
        this.loadCurrentUserLocation();

        Logger.log('[UserLocation] System initialized');
    },

    /**
     * Load current user's own location on page load
     */
    async loadCurrentUserLocation() {
        // Wait for auth to be ready (max 10 seconds)
        let attempts = 0;
        while (attempts < 50) {
            if (AuthSystem.isLoggedIn()) {
                break;
            }
            await new Promise(r => setTimeout(r, 200));
            attempts++;
        }

        if (!AuthSystem.isLoggedIn()) {
            return;
        }

        try {
            const response = await fetch(`${QBitmapConfig.api.users}/me/location`, {
                credentials: 'include'
            });

            if (!response.ok) {
                return;
            }

            const data = await response.json();
            const location = data.location;

            // If user has location with showOnMap enabled, show it
            if (location && location.lat && location.lng && location.showOnMap) {
                // Wait for map to exist first
                let mapAttempts = 0;
                while (!AppState.map && mapAttempts < 50) {
                    await new Promise(r => setTimeout(r, 200));
                    mapAttempts++;
                }

                if (!AppState.map) {
                    return;
                }

                // If style is already loaded, proceed immediately
                if (!AppState.map.isStyleLoaded()) {
                    // Wait for map load event
                    await new Promise((resolve) => {
                        if (AppState.map.isStyleLoaded()) {
                            resolve();
                            return;
                        }

                        const timeout = setTimeout(resolve, 15000);

                        AppState.map.once('load', () => {
                            clearTimeout(timeout);
                            resolve();
                        });

                        AppState.map.once('idle', () => {
                            clearTimeout(timeout);
                            resolve();
                        });
                    });
                }

                // skipSave=true because we're loading existing location, not setting new one
                await this.showLocation(location.lng, location.lat, location.accuracy || 0, true);
                Logger.log('[UserLocation] Loaded user location from backend');
            }
        } catch (error) {
            Logger.log('[UserLocation] Error loading location:', error);
        }
    },

    /**
     * Wait for map to be ready, then load public locations
     */
    waitForMapAndLoadPublicLocations() {
        const checkMap = () => {
            if (AppState.map && AppState.map.isStyleLoaded()) {
                this.loadPublicLocations();
            } else {
                setTimeout(checkMap, 500);
            }
        };
        checkMap();
    },

    /**
     * Load and display public user locations on the map
     */
    async loadPublicLocations() {
        if (this.publicUsersLoaded) return;

        try {
            const response = await fetch(`${QBitmapConfig.api.public}/user-locations`);
            if (!response.ok) return;

            const geojson = await response.json();

            if (!geojson.features || geojson.features.length === 0) {
                Logger.log('[UserLocation] No public user locations found');
                return;
            }

            const map = AppState.map;

            // Remove existing markers
            this.clearPublicMarkers();

            // Create HTML markers for each public user
            for (const feature of geojson.features) {
                const coords = feature.geometry.coordinates;
                const props = feature.properties;

                // Create marker element with avatar
                const el = this.createPublicUserMarkerElement(props, coords);

                // Create marker
                const marker = new maplibregl.Marker({
                    element: el,
                    anchor: 'center'
                })
                .setLngLat(coords)
                .addTo(map);

                // Store marker and its data for popup
                marker._userData = props;
                this.publicMarkers.push(marker);
            }

            // Show/hide markers based on zoom level
            const updateMarkerVisibility = () => {
                const visible = map.getZoom() >= 13;
                for (const m of this.publicMarkers) {
                    m.getElement().style.display = visible ? '' : 'none';
                }
            };
            map.on('zoomend', updateMarkerVisibility);
            updateMarkerVisibility();

            this.publicUsersLoaded = true;
            Logger.log(`[UserLocation] Loaded ${geojson.features.length} public user locations`);

        } catch (error) {
            Logger.log('[UserLocation] Error loading public locations:', error);
        }
    },

    /**
     * Create marker element for public user with avatar
     */
    createPublicUserMarkerElement(props, lngLat) {
        // Outer container for MapLibre (don't apply transforms here!)
        const container = document.createElement('div');
        container.className = 'public-user-marker-container';
        container.style.cssText = `
            width: 28px;
            height: 28px;
            cursor: pointer;
        `;

        // Inner element for avatar (apply transforms here)
        const el = document.createElement('div');
        el.className = 'public-user-marker';
        el.style.cssText = `
            width: 100%;
            height: 100%;
            border-radius: 50%;
            border: 2px solid #10b981;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            background-color: #10b981;
            background-size: cover;
            background-position: center;
            transition: transform 0.2s ease;
        `;

        // Use avatar if available, otherwise show initials
        if (props.avatarUrl) {
            el.style.backgroundImage = `url(${props.avatarUrl})`;
            el.style.backgroundColor = '#fff';
        } else {
            // Show initials
            const initials = (props.displayName || 'U').charAt(0).toUpperCase();
            el.innerHTML = `<span style="color: #fff; font-weight: bold; font-size: 12px; display: flex; align-items: center; justify-content: center; height: 100%;">${escapeHtml(initials)}</span>`;
        }

        container.appendChild(el);

        // Store lngLat for popup
        container._lngLat = lngLat;

        // Hover effect on container (scale only, no popup)
        container.addEventListener('mouseenter', () => {
            el.style.transform = 'scale(1.3)';
        });

        container.addEventListener('mouseleave', () => {
            el.style.transform = 'scale(1)';
        });

        return container;
    },

    /**
     * Show popup for public user from props
     */
    showPublicUserPopupFromProps(props, lngLat) {
        // Clear any pending hide timeout
        if (this.hidePopupTimeout) {
            clearTimeout(this.hidePopupTimeout);
            this.hidePopupTimeout = null;
        }

        // Remove existing popup first
        if (this.popup) {
            this.popup.remove();
            this.popup = null;
        }

        const html = `
            <div class="user-location-popup">
                <div class="popup-name">${this.escapeHtml(props.displayName)}</div>
                <div class="popup-info">
                    <span class="popup-cameras">${props.cameraCount || 0} kamera</span>
                    ${props.accuracy ? `<span class="popup-accuracy">±${Math.round(props.accuracy)}m</span>` : ''}
                </div>
            </div>
        `;

        this.popup = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: [20, 0], // Position to the right instead of above
            anchor: 'left',
            className: 'user-location-popup-container no-pointer-events'
        })
        .setLngLat(lngLat)
        .setHTML(html)
        .addTo(AppState.map);
    },

    /**
     * Clear all public user markers
     */
    clearPublicMarkers() {
        for (const marker of this.publicMarkers) {
            marker.remove();
        }
        this.publicMarkers = [];
    },

    /**
     * Refresh public locations (call after visibility change)
     */
    async refreshPublicLocations() {
        this.clearPublicMarkers();
        this.publicUsersLoaded = false;
        await this.loadPublicLocations();
    },

    /**
     * Show user location on map and optionally save to backend
     * @param {number} lng - Longitude
     * @param {number} lat - Latitude
     * @param {number} accuracy - Accuracy in meters
     * @param {boolean} skipSave - If true, don't save to backend (used when loading existing location)
     */
    async showLocation(lng, lat, accuracy, skipSave = false) {
        this.currentPosition = { lng, lat, accuracy };

        const map = AppState.map;
        if (!map) return;

        // Get user info
        const user = AuthSystem.user;

        // Save location to backend if logged in (unless skipSave is true)
        if (!skipSave && AuthSystem.isLoggedIn()) {
            this.saveLocationToBackend(lat, lng, accuracy);
        }
        const displayName = user?.displayName || 'Kullanıcı';
        const avatarUrl = user?.avatarUrl || '';

        // Create avatar icon if needed
        if (!map.hasImage('user-location-avatar')) {
            await this.createAvatarIcon(avatarUrl);
        }

        // GeoJSON data
        const data = {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [lng, lat]
                },
                properties: {
                    displayName: displayName,
                    accuracy: accuracy,
                    cameraCount: this.getUserCameraCount()
                }
            }]
        };

        // Update or create source
        if (map.getSource('user-location')) {
            map.getSource('user-location').setData(data);
        } else {
            map.addSource('user-location', { type: 'geojson', data });

            // Accuracy circle layer
            map.addLayer({
                id: 'user-location-accuracy',
                type: 'circle',
                source: 'user-location',
                minzoom: 13,
                paint: {
                    'circle-radius': [
                        'interpolate',
                        ['exponential', 2],
                        ['zoom'],
                        14, ['/', ['get', 'accuracy'], 10],
                        18, ['/', ['get', 'accuracy'], 2],
                        20, ['get', 'accuracy']
                    ],
                    'circle-color': 'rgba(59, 130, 246, 0.12)',
                    'circle-stroke-color': 'rgba(59, 130, 246, 0.4)',
                    'circle-stroke-width': 2
                }
            });

            // Avatar marker layer
            map.addLayer({
                id: 'user-location-marker',
                type: 'symbol',
                source: 'user-location',
                minzoom: 13,
                layout: {
                    'icon-image': 'user-location-avatar',
                    'icon-size': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        14, 0.4,
                        18, 0.7
                    ],
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true
                }
            });

            // Hover popup
            map.on('mouseenter', 'user-location-marker', (e) => {
                map.getCanvas().style.cursor = 'pointer';
                this.showPopup(e);
            });

            map.on('mouseleave', 'user-location-marker', () => {
                map.getCanvas().style.cursor = '';
                this.hidePopup();
            });
        }

        this.isVisible = true;
        Logger.log(`[UserLocation] Showing location: ${lat.toFixed(6)}, ${lng.toFixed(6)} (±${Math.round(accuracy)}m)`);
    },

    /**
     * Create circular avatar icon from URL
     */
    async createAvatarIcon(avatarUrl) {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            const size = 64;
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            const addCanvasImage = () => {
                const imageData = ctx.getImageData(0, 0, size, size);
                AppState.map.addImage('user-location-avatar', {
                    width: size,
                    height: size,
                    data: imageData.data
                }, { pixelRatio: 2 });
                resolve();
            };

            const drawFallback = () => {
                // Blue circle with white border
                ctx.beginPath();
                ctx.arc(size/2, size/2, size/2 - 4, 0, Math.PI * 2);
                ctx.fillStyle = '#3b82f6';
                ctx.fill();

                // White border
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 4;
                ctx.stroke();

                // User icon
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 24px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('👤', size/2, size/2);

                addCanvasImage();
            };

            if (!avatarUrl) {
                drawFallback();
                return;
            }

            // Use image proxy for Google avatars to bypass CORS
            let imageUrl = avatarUrl;
            if (avatarUrl.includes('googleusercontent.com')) {
                imageUrl = `${QBitmapConfig.api.public}/image-proxy?url=${encodeURIComponent(avatarUrl)}`;
            }

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                // Save context
                ctx.save();

                // Create circular clip
                ctx.beginPath();
                ctx.arc(size/2, size/2, size/2 - 4, 0, Math.PI * 2);
                ctx.closePath();
                ctx.clip();

                // Draw avatar
                ctx.drawImage(img, 4, 4, size - 8, size - 8);

                // Restore to draw border
                ctx.restore();

                // White outer border
                ctx.beginPath();
                ctx.arc(size/2, size/2, size/2 - 2, 0, Math.PI * 2);
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 4;
                ctx.stroke();

                // Blue accent border
                ctx.beginPath();
                ctx.arc(size/2, size/2, size/2 - 4, 0, Math.PI * 2);
                ctx.strokeStyle = '#3b82f6';
                ctx.lineWidth = 2;
                ctx.stroke();

                addCanvasImage();
            };
            img.onerror = drawFallback;
            img.src = imageUrl;
        });
    },

    /**
     * Show info popup on hover
     */
    showPopup(e) {
        const props = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates.slice();

        const html = `
            <div class="user-location-popup">
                <div class="popup-name">${this.escapeHtml(props.displayName)}</div>
                <div class="popup-info">
                    <span class="popup-cameras">${props.cameraCount} kamera</span>
                    <span class="popup-accuracy">±${Math.round(props.accuracy)}m</span>
                </div>
            </div>
        `;

        this.popup = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 20,
            className: 'user-location-popup-container'
        })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(AppState.map);
    },

    /**
     * Hide popup with small delay to prevent flickering
     */
    hidePopup() {
        // Clear any pending hide timeout
        if (this.hidePopupTimeout) {
            clearTimeout(this.hidePopupTimeout);
        }

        // Small delay before hiding to prevent race conditions
        this.hidePopupTimeout = setTimeout(() => {
            if (this.popup) {
                this.popup.remove();
                this.popup = null;
            }
            this.hidePopupTimeout = null;
        }, 100);
    },

    /**
     * Hide user location from map
     */
    hide() {
        const map = AppState.map;
        if (!map) return;

        this.hidePopup();

        if (map.getLayer('user-location-marker')) {
            map.removeLayer('user-location-marker');
        }
        if (map.getLayer('user-location-accuracy')) {
            map.removeLayer('user-location-accuracy');
        }
        if (map.getSource('user-location')) {
            map.removeSource('user-location');
        }
        if (map.hasImage('user-location-avatar')) {
            map.removeImage('user-location-avatar');
        }

        this.isVisible = false;
        this.currentPosition = null;
        Logger.log('[UserLocation] Hidden');
    },

    /**
     * Get user's camera count
     */
    getUserCameraCount() {
        if (CameraSystem) {
            const userCameras = CameraSystem.cameras?.filter(c => !c.isShared) || [];
            return userCameras.length;
        }
        return 0;
    },

    /**
     * Escape HTML
     */
    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, (m) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
    },

    /**
     * Save location to backend
     */
    async saveLocationToBackend(lat, lng, accuracy) {
        try {
            const response = await fetch(`${QBitmapConfig.api.base}/api/users/me/location`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ lat, lng, accuracy, showOnMap: true })
            });

            if (response.ok) {
                Logger.log('[UserLocation] Location saved to backend');
            } else {
                Logger.log('[UserLocation] Failed to save location to backend');
            }
        } catch (error) {
            Logger.log('[UserLocation] Error saving location:', error);
        }
    },

    /**
     * Update location visibility setting
     */
    async setLocationVisibility(showOnMap) {
        try {
            const response = await fetch(`${QBitmapConfig.api.base}/api/users/me/location/visibility`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ showOnMap })
            });

            if (response.ok) {
                const data = await response.json();
                Logger.log('[UserLocation] Visibility updated:', showOnMap);
                return data.location;
            }
        } catch (error) {
            Logger.log('[UserLocation] Error updating visibility:', error);
        }
        return null;
    },

    // ==================== Locate Me ====================

    _locateDot: null,

    /**
     * Find user's location and fly the map there with a pulsing dot
     */
    async locateMe() {
        const btn = document.getElementById('locate-me-button');
        if (btn) btn.classList.add('searching');

        try {
            const loc = await LocationService.get({
                purpose: 'profile',
                acceptThresholdM: 25,
                approximateMaxM: 200
            });

            if (AppState.map) {
                const targetZoom = loc.quality === 'precise' ? 17 : (loc.quality === 'approximate' ? 14 : 11);
                AppState.map.flyTo({
                    center: [loc.lng, loc.lat],
                    zoom: Math.max(AppState.map.getZoom(), targetZoom),
                    duration: 1000
                });
            }

            this._showPulsingDot(loc.lng, loc.lat);
            Logger.log(`[UserLocation] Located: ${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)} (±${loc.accuracy_radius_m}m, ${loc.source})`);
        } catch (error) {
            Logger.warn('[UserLocation] Locate failed:', error);
            AuthSystem.showNotification('Konum alınamadı', 'error');
        } finally {
            if (btn) btn.classList.remove('searching');
        }
    },

    /**
     * Show a pulsing blue dot at the given coordinates
     */
    _showPulsingDot(lng, lat) {
        // Remove existing dot
        if (this._locateDot) {
            this._locateDot.remove();
            this._locateDot = null;
        }

        const el = document.createElement('div');
        el.className = 'locate-me-marker';
        el.innerHTML = '<div class="locate-me-pulse"></div><div class="locate-me-dot"></div>';

        this._locateDot = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([lng, lat])
            .addTo(AppState.map);
    }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    UserLocationSystem.init();
});

export { UserLocationSystem };
