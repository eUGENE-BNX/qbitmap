import { PopupCoreMixin } from './core.js';
import { StreamingMixin } from './streaming.js';
import { SearchFaceMixin } from './search-face.js';
import { AiMixin } from './ai.js';
import { VoiceCallMixin } from './voice-call.js';

const PopupMixin = {};
Object.assign(PopupMixin,
  PopupCoreMixin, StreamingMixin, SearchFaceMixin, AiMixin, VoiceCallMixin
);

export { PopupMixin };
