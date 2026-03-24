/**
 * 3D Model Manager for MapLibre GL JS v5+
 * Using defaultProjectionData.mainMatrix per official docs
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { layers } from './state.js';

const ModelManager = {
  models: new Map(),

  addModel(map, options) {
    const {
      id, url, coordinates, altitude = 0,
      rotation = [Math.PI / 2, 0, 0], scale = 1,
      minZoom = 15, popupContent, animate = null
    } = options;

    const modelOrigin = maplibregl.MercatorCoordinate.fromLngLat(coordinates, 0);
    const modelTransform = {
      translateX: modelOrigin.x,
      translateY: modelOrigin.y,
      translateZ: modelOrigin.meterInMercatorCoordinateUnits() * altitude,
      rotateX: rotation[0],
      rotateY: rotation[1],
      rotateZ: rotation[2],
      scale: modelOrigin.meterInMercatorCoordinateUnits() * scale
    };

    let mapRef = map;

    const customLayer = {
      id: id,
      type: "custom",
      renderingMode: "3d",

      onAdd(mapInstance, gl) {
        mapRef = mapInstance;

        const camera = new THREE.Camera();
        const scene = new THREE.Scene();

        scene.add(new THREE.AmbientLight(0xffffff, 0.8));
        const d1 = new THREE.DirectionalLight(0xffffff, 0.6);
        d1.position.set(0, -70, 100).normalize();
        scene.add(d1);
        const d2 = new THREE.DirectionalLight(0xffffff, 0.4);
        d2.position.set(0, 70, 100).normalize();
        scene.add(d2);

        const renderer = new THREE.WebGLRenderer({
          canvas: mapInstance.getCanvas(),
          context: gl,
          antialias: true
        });
        renderer.autoClear = false;
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        // [PERF] Pre-allocate reusable matrix/vector objects to avoid GC pressure
        const _rotationX = new THREE.Matrix4();
        const _rotationY = new THREE.Matrix4();
        const _rotationZ = new THREE.Matrix4();
        const _axisX = new THREE.Vector3(1, 0, 0);
        const _axisY = new THREE.Vector3(0, 1, 0);
        const _axisZ = new THREE.Vector3(0, 0, 1);
        const _projMatrix = new THREE.Matrix4();
        const _localMatrix = new THREE.Matrix4();
        const _scaleVec = new THREE.Vector3();

        ModelManager.models.set(id, {
          camera, scene, renderer, coordinates, popupContent, loaded: false,
          // Store reusable objects
          _rotationX, _rotationY, _rotationZ, _axisX, _axisY, _axisZ,
          _projMatrix, _localMatrix, _scaleVec
        });

        new GLTFLoader().load(
          url,
          (gltf) => {
            scene.add(gltf.scene);
            ModelManager.models.get(id).loaded = true;
            mapInstance.triggerRepaint();
          },
          null,
          (e) => console.error("[3D] Error:", e)
        );
      },

      render(gl, args) {
        if (!layers.object3DLayerVisible) return;
        if (mapRef.getZoom() < minZoom) return;

        const md = ModelManager.models.get(id);
        if (!md || !md.loaded) return;

        const { camera, scene, renderer,
          _rotationX, _rotationY, _rotationZ, _axisX, _axisY, _axisZ,
          _projMatrix, _localMatrix, _scaleVec } = md;

        if (animate) {
          if (!this._ang) this._ang = 0;
          this._ang += animate.speed || 0.01;
          if (this._ang > Math.PI * 2) this._ang -= Math.PI * 2;
        }

        let rX = modelTransform.rotateX, rY = modelTransform.rotateY, rZ = modelTransform.rotateZ;
        if (animate) {
          if (animate.axis === "x") rX += this._ang;
          else if (animate.axis === "y") rY += this._ang;
          else if (animate.axis === "z") rZ += this._ang;
        }

        // [PERF] Reuse pre-allocated objects instead of creating new ones
        _rotationX.makeRotationAxis(_axisX, rX);
        _rotationY.makeRotationAxis(_axisY, rY);
        _rotationZ.makeRotationAxis(_axisZ, rZ);

        _projMatrix.fromArray(args.defaultProjectionData.mainMatrix);
        _scaleVec.set(modelTransform.scale, -modelTransform.scale, modelTransform.scale);
        _localMatrix
          .makeTranslation(modelTransform.translateX, modelTransform.translateY, modelTransform.translateZ)
          .scale(_scaleVec)
          .multiply(_rotationX)
          .multiply(_rotationY)
          .multiply(_rotationZ);

        camera.projectionMatrix = _projMatrix.multiply(_localMatrix);

        renderer.resetState();
        renderer.render(scene, camera);
        mapRef.triggerRepaint();
      }
    };

    map.addLayer(customLayer);

    if (popupContent) {
      map.on("click", (e) => {
        if (map.getZoom() < minZoom) return;
        const dist = Math.sqrt(Math.pow(e.lngLat.lng - coordinates[0], 2) + Math.pow(e.lngLat.lat - coordinates[1], 2));
        if (dist < 0.0005 / Math.pow(2, map.getZoom() - 15)) {
          new maplibregl.Popup({ closeButton: true, closeOnClick: true })
            .setLngLat(coordinates).setHTML(popupContent).addTo(map);
        }
      });
    }
  },

  removeModel(map, id) {
    if (map.getLayer(id)) { map.removeLayer(id); this.models.delete(id); }
  }
};

export { ModelManager };
