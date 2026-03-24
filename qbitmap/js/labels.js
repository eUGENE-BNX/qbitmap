import { Logger } from './utils.js';

// Label layers for Turkish map
function addLabels(map, sourceId) {
    const textColor = "#2d3748";
    const textHaloColor = "rgba(255, 255, 255, 0.9)";
    const textHaloWidth = 2;

    // 1. Place labels (cities, neighborhoods) - zoom 8+
    map.addLayer({
        id: "place-labels",
        type: "symbol",
        source: sourceId,
        "source-layer": "places",
        minzoom: 8,
        filter: ["in", ["get", "kind"], ["literal", ["city", "town", "village", "neighbourhood"]]],
        layout: {
            "text-field": ["coalesce", ["get", "name:tr"], ["get", "name"]],
            "text-font": ["Noto Sans Medium"],
            "text-size": [
                "interpolate", ["linear"], ["zoom"],
                8, ["case", ["==", ["get", "kind"], "city"], 14, 10],
                12, ["case", ["==", ["get", "kind"], "city"], 18, 12],
                16, ["case", ["==", ["get", "kind"], "city"], 22, 14]
            ],
            "text-anchor": "center",
            "text-max-width": 8,
            "text-allow-overlap": false,
            "text-ignore-placement": false
        },
        paint: {
            "text-color": textColor,
            "text-halo-color": textHaloColor,
            "text-halo-width": textHaloWidth
        }
    });

    // 2. Road labels (street names) - zoom 14+
    map.addLayer({
        id: "road-labels",
        type: "symbol",
        source: sourceId,
        "source-layer": "roads",
        minzoom: 14,
        filter: ["in", ["get", "kind"], ["literal", ["highway", "major_road", "minor_road", "path"]]],
        layout: {
            "text-field": ["coalesce", ["get", "name:tr"], ["get", "name"]],
            "text-font": ["Noto Sans Medium"],
            "text-size": [
                "interpolate", ["linear"], ["zoom"],
                14, 10,
                18, 13
            ],
            "symbol-placement": "line",
            "text-rotation-alignment": "map",
            "text-pitch-alignment": "viewport",
            "text-max-angle": 30,
            "text-allow-overlap": false
        },
        paint: {
            "text-color": textColor,
            "text-halo-color": textHaloColor,
            "text-halo-width": 1.5
        }
    });

    // 3. House numbers - zoom 17+
    map.addLayer({
        id: "housenumber-labels",
        type: "symbol",
        source: sourceId,
        "source-layer": "buildings",
        minzoom: 17,
        filter: ["has", "addr_housenumber"],
        layout: {
            "text-field": ["get", "addr_housenumber"],
            "text-font": ["Noto Sans Medium"],
            "text-size": 10,
            "text-allow-overlap": false,
            "text-ignore-placement": false
        },
        paint: {
            "text-color": "#4a5568",
            "text-halo-color": "rgba(255, 255, 255, 0.8)",
            "text-halo-width": 1.5
        }
    });

    // 4. POI labels (points of interest) - zoom 15+
    map.addLayer({
        id: "poi-labels",
        type: "symbol",
        source: sourceId,
        "source-layer": "pois",
        minzoom: 15,
        filter: ["in", ["get", "kind"], ["literal", ["restaurant", "cafe", "hospital", "school", "bank", "hotel", "park"]]],
        layout: {
            "text-field": ["coalesce", ["get", "name:tr"], ["get", "name"]],
            "text-font": ["Noto Sans Medium"],
            "text-size": 11,
            "text-anchor": "top",
            "text-offset": [0, 0.5],
            "text-max-width": 9,
            "text-allow-overlap": false
        },
        paint: {
            "text-color": "#2d3748",
            "text-halo-color": textHaloColor,
            "text-halo-width": 1.5
        }
    });

    Logger.log("Label layers added successfully");
}

export { addLabels };
