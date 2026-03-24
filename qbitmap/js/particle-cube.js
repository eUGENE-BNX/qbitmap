/**
 * Particle Cube Layer for MapLibre GL JS
 * Based on Three.js webgl_buffergeometry_drawrange example
 */
import * as THREE from "three";
import { layers } from './state.js';

const ParticleCubeLayer = {
  layers: new Map(),

  add(map, options) {
    const {
      id,
      coordinates,
      altitude = 0,
      cubeSize = 50,
      particleCount = 500,
      minDistance = 30,
      maxConnections = 20,
      minZoom = 14
    } = options;

    const modelOrigin = maplibregl.MercatorCoordinate.fromLngLat(coordinates, 0);
    const scale = modelOrigin.meterInMercatorCoordinateUnits();

    const modelTransform = {
      translateX: modelOrigin.x,
      translateY: modelOrigin.y,
      translateZ: scale * altitude,
      scale: scale
    };

    let mapRef = map;
    const maxParticleCount = 1000;

    const customLayer = {
      id: id,
      type: "custom",
      renderingMode: "3d",

      onAdd(mapInstance, gl) {
        mapRef = mapInstance;

        // Three.js setup
        const camera = new THREE.Camera();
        const scene = new THREE.Scene();

        const renderer = new THREE.WebGLRenderer({
          canvas: mapInstance.getCanvas(),
          context: gl,
          antialias: true
        });
        renderer.autoClear = false;

        // Create group for rotation
        const group = new THREE.Group();
        scene.add(group);

        // Box helper (cube outline) - black edges
        const boxGeometry = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
        const edges = new THREE.EdgesGeometry(boxGeometry);
        const lineMat = new THREE.LineBasicMaterial({
          color: 0x000000,
          linewidth: 2
        });
        const cubeEdges = new THREE.LineSegments(edges, lineMat);
        group.add(cubeEdges);

        // Particle positions and data
        const particlePositions = new Float32Array(maxParticleCount * 3);
        const particleData = [];
        const halfSize = cubeSize / 2;

        for (let i = 0; i < maxParticleCount; i++) {
          const x = Math.random() * cubeSize - halfSize;
          const y = Math.random() * cubeSize - halfSize;
          const z = Math.random() * cubeSize - halfSize;

          particlePositions[i * 3] = x;
          particlePositions[i * 3 + 1] = y;
          particlePositions[i * 3 + 2] = z;

          particleData.push({
            velocity: new THREE.Vector3(
              -0.5 + Math.random(),
              -0.5 + Math.random(),
              -0.5 + Math.random()
            ).multiplyScalar(0.15),
            numConnections: 0
          });
        }

        // Points geometry
        const pointsGeometry = new THREE.BufferGeometry();
        pointsGeometry.setAttribute(
          "position",
          new THREE.BufferAttribute(particlePositions, 3).setUsage(THREE.DynamicDrawUsage)
        );
        pointsGeometry.setDrawRange(0, particleCount);

        // Points material - black particles
        const pointsMaterial = new THREE.PointsMaterial({
          color: 0x000000,
          size: 3,
          transparent: true,
          opacity: 0.9
        });

        const pointCloud = new THREE.Points(pointsGeometry, pointsMaterial);
        group.add(pointCloud);

        // Lines geometry
        const maxLineSegments = maxParticleCount * maxParticleCount;
        const linePositions = new Float32Array(maxLineSegments * 3);
        const lineColors = new Float32Array(maxLineSegments * 3);

        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute(
          "position",
          new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage)
        );
        lineGeometry.setAttribute(
          "color",
          new THREE.BufferAttribute(lineColors, 3).setUsage(THREE.DynamicDrawUsage)
        );
        lineGeometry.setDrawRange(0, 0);

        const lineMaterial = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.8
        });

        const linesMesh = new THREE.LineSegments(lineGeometry, lineMaterial);
        group.add(linesMesh);

        // Pre-allocate matrices
        const _projMatrix = new THREE.Matrix4();
        const _localMatrix = new THREE.Matrix4();
        const _scaleVec = new THREE.Vector3();

        // Store layer data
        ParticleCubeLayer.layers.set(id, {
          camera,
          scene,
          renderer,
          group,
          particlePositions,
          particleData,
          pointsGeometry,
          lineGeometry,
          linePositions,
          lineColors,
          halfSize,
          particleCount,
          minDistance,
          maxConnections,
          _projMatrix,
          _localMatrix,
          _scaleVec,
          time: 0
        });

        mapInstance.triggerRepaint();
      },

      render(gl, args) {
        if (!layers.object3DLayerVisible) return;
        if (mapRef.getZoom() < minZoom) return;

        const ld = ParticleCubeLayer.layers.get(id);
        if (!ld) return;

        const {
          camera, scene, renderer, group,
          particlePositions, particleData, pointsGeometry,
          lineGeometry, linePositions, lineColors,
          halfSize, minDistance: minDist, maxConnections: maxConn,
          _projMatrix, _localMatrix, _scaleVec
        } = ld;

        let { particleCount: pCount, time } = ld;

        // Update time
        time += 0.01;
        ld.time = time;

        // Rotate group
        group.rotation.y = time * 0.3;

        // Update particle positions
        for (let i = 0; i < pCount; i++) {
          const pd = particleData[i];
          pd.numConnections = 0;

          particlePositions[i * 3] += pd.velocity.x;
          particlePositions[i * 3 + 1] += pd.velocity.y;
          particlePositions[i * 3 + 2] += pd.velocity.z;

          // Bounce off walls
          if (particlePositions[i * 3] < -halfSize || particlePositions[i * 3] > halfSize) {
            pd.velocity.x = -pd.velocity.x;
          }
          if (particlePositions[i * 3 + 1] < -halfSize || particlePositions[i * 3 + 1] > halfSize) {
            pd.velocity.y = -pd.velocity.y;
          }
          if (particlePositions[i * 3 + 2] < -halfSize || particlePositions[i * 3 + 2] > halfSize) {
            pd.velocity.z = -pd.velocity.z;
          }
        }

        // Update connections
        let numConnected = 0;
        for (let i = 0; i < pCount; i++) {
          for (let j = i + 1; j < pCount; j++) {
            const pd1 = particleData[i];
            const pd2 = particleData[j];

            if (pd1.numConnections >= maxConn || pd2.numConnections >= maxConn) continue;

            const dx = particlePositions[i * 3] - particlePositions[j * 3];
            const dy = particlePositions[i * 3 + 1] - particlePositions[j * 3 + 1];
            const dz = particlePositions[i * 3 + 2] - particlePositions[j * 3 + 2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (dist < minDist) {
              pd1.numConnections++;
              pd2.numConnections++;

              const alpha = 1.0 - dist / minDist;

              linePositions[numConnected * 6] = particlePositions[i * 3];
              linePositions[numConnected * 6 + 1] = particlePositions[i * 3 + 1];
              linePositions[numConnected * 6 + 2] = particlePositions[i * 3 + 2];

              linePositions[numConnected * 6 + 3] = particlePositions[j * 3];
              linePositions[numConnected * 6 + 4] = particlePositions[j * 3 + 1];
              linePositions[numConnected * 6 + 5] = particlePositions[j * 3 + 2];

              // Black color - closer = darker, farther = lighter gray
              const gray = 1.0 - alpha; // 0 = black, 1 = white
              lineColors[numConnected * 6] = gray * 0.3;
              lineColors[numConnected * 6 + 1] = gray * 0.3;
              lineColors[numConnected * 6 + 2] = gray * 0.3;

              lineColors[numConnected * 6 + 3] = gray * 0.3;
              lineColors[numConnected * 6 + 4] = gray * 0.3;
              lineColors[numConnected * 6 + 5] = gray * 0.3;

              numConnected++;
            }
          }
        }

        // Update geometries
        pointsGeometry.attributes.position.needsUpdate = true;
        lineGeometry.attributes.position.needsUpdate = true;
        lineGeometry.attributes.color.needsUpdate = true;
        lineGeometry.setDrawRange(0, numConnected * 2);

        // Setup camera matrix
        _projMatrix.fromArray(args.defaultProjectionData.mainMatrix);
        _scaleVec.set(modelTransform.scale, -modelTransform.scale, modelTransform.scale);
        _localMatrix
          .makeTranslation(modelTransform.translateX, modelTransform.translateY, modelTransform.translateZ)
          .scale(_scaleVec);

        camera.projectionMatrix = _projMatrix.multiply(_localMatrix);

        renderer.resetState();
        renderer.render(scene, camera);
        mapRef.triggerRepaint();
      }
    };

    map.addLayer(customLayer);
  },

  remove(map, id) {
    if (map.getLayer(id)) {
      map.removeLayer(id);
      this.layers.delete(id);
    }
  }
};

export { ParticleCubeLayer };
