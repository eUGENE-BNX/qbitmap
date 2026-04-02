import { CameraSystem } from '../camera-system/index.js';

export const TeslaWebSocket = {
  onVehiclesList: null,
  onVehicleUpdate: null,
  subscribed: false,
  _handler: null,

  init(onVehiclesList, onVehicleUpdate) {
    this.onVehiclesList = onVehiclesList;
    this.onVehicleUpdate = onVehicleUpdate;
  },

  subscribe() {
    if (this.subscribed) return;
    this.subscribed = true;

    // Find existing WebSocket connection
    const ws = this._getWs();
    if (!ws) return;

    // Listen for Tesla messages
    this._handler = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'tesla_vehicles' && this.onVehiclesList) {
          this.onVehiclesList(msg.payload);
        } else if (msg.type === 'tesla_vehicle_update' && this.onVehicleUpdate) {
          this.onVehicleUpdate(msg.payload);
        }
      } catch { /* ignore non-json */ }
    };
    ws.addEventListener('message', this._handler);

    // Send subscribe message
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe_tesla' }));
    }
  },

  unsubscribe() {
    if (!this.subscribed) return;
    this.subscribed = false;

    const ws = this._getWs();
    if (ws && this._handler) {
      ws.removeEventListener('message', this._handler);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe_tesla' }));
      }
    }
    this._handler = null;
  },

  _getWs() {
    // Access the WebSocket from CameraSystem module
    if (CameraSystem?.ws && CameraSystem.ws.readyState === WebSocket.OPEN) {
      return CameraSystem.ws;
    }
    return null;
  }
};
