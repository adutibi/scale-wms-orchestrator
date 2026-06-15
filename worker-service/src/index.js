const transport = (process.env.TRANSPORT || "http").toLowerCase();

if (transport === "rabbitmq") {
  require("./rabbitmq-consumer");
} else {
  require("./http-server");
}
