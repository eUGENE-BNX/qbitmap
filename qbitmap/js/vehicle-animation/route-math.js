/**
 * Pure math utilities for route calculations
 */

export function haversineDistance(c1, c2) {
  var R = 6371;
  var dLat = (c2[1] - c1[1]) * Math.PI / 180;
  var dLon = (c2[0] - c1[0]) * Math.PI / 180;
  var lat1 = c1[1] * Math.PI / 180;
  var lat2 = c2[1] * Math.PI / 180;
  var a = Math.pow(Math.sin(dLat/2), 2) + Math.pow(Math.sin(dLon/2), 2) * Math.cos(lat1) * Math.cos(lat2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export function calculateRouteLength(coords) {
  var length = 0;
  for (var i = 0; i < coords.length - 1; i++) {
    length += haversineDistance(coords[i], coords[i + 1]);
  }
  return length;
}

export function getPointAlongRoute(coords, routeLength, progress) {
  var targetDist = progress * routeLength;
  var acc = 0;
  for (var i = 0; i < coords.length - 1; i++) {
    var segDist = haversineDistance(coords[i], coords[i + 1]);
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
}

export function calculateBearing(start, end) {
  var toRad = function(x) { return x * Math.PI / 180; };
  var dLng = toRad(end[0] - start[0]);
  var lat1 = toRad(start[1]);
  var lat2 = toRad(end[1]);
  var x = Math.sin(dLng) * Math.cos(lat2);
  var y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}
