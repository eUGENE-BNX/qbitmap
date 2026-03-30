import { CoreMixin } from './core.js';
import { MapLayerMixin } from './map-layer.js';
import { PopupMixin } from './popup.js';
import { AiSearchMixin } from './ai-search.js';
import { AiAnalyzeMixin } from './ai-analyze.js';
import { FaceDetectionMixin } from './face-detection.js';
import { ControlsMixin } from './controls.js';
import { GeoMixin } from './geo.js';

const LiveBroadcast = {};

Object.assign(
  LiveBroadcast,
  CoreMixin,
  MapLayerMixin,
  PopupMixin,
  AiSearchMixin,
  AiAnalyzeMixin,
  FaceDetectionMixin,
  ControlsMixin,
  GeoMixin
);

export { LiveBroadcast };
