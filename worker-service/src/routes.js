const { matchScaleRoute } = require("../config/scaleRoutes");

const QUERY_SHIPMENT_BY_ID_WAREHOUSE = "ShipmentHeader.by.ShipmentId.and.Warehouse";

function isScaleShipmentHeadersGet(payload) {
  const route = matchScaleRoute(payload.method, payload.path);
  return route !== null && route.name === "ShipmentHeadersApi.Get";
}

function getShipmentHeadersParams(payload) {
  const query = payload.query || {};
  const shipmentId = query.shipmentId || query.shipmentID;
  const warehouse = query.warehouse;
  if (!shipmentId || !warehouse) {
    return {
      error: "Missing required query parameters: shipmentId and warehouse",
    };
  }
  return {
    params: {
      shipmentID: String(shipmentId),
      warehouse: String(warehouse),
    },
  };
}

module.exports = {
  QUERY_SHIPMENT_BY_ID_WAREHOUSE,
  isScaleShipmentHeadersGet,
  getShipmentHeadersParams,
};
