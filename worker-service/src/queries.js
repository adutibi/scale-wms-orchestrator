/**
 * Named query registry. Each entry defines SQL and typed parameter bindings.
 * Param types map to mssql types: Int, NVarChar, VarChar, DateTime, Bit, etc.
 */
module.exports = {
  ping: {
    sql: "SELECT 1 AS ok",
    params: {},
  },
  "db-info": {
    sql: "SELECT DB_NAME() AS databaseName, @@VERSION AS version",
    params: {},
  },
  "list-tables": {
    sql: `
      SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `,
    params: {},
  },
  "ShipmentHeader.by.ShipmentId.and.Warehouse": {
    sql: `
      SELECT sh.*
      FROM SHIPMENT_HEADER sh
      WHERE sh.SHIPMENT_ID = @shipmentID
        AND sh.warehouse = @warehouse
    `,
    params: {
      shipmentID: "NVarChar",
      warehouse: "NVarChar",
    },
  },
};
