const transport = (process.env.TRANSPORT || "http").toLowerCase();

if (transport === "rabbitmq") {
  require("./rabbitmq-consumer");
} else if (transport === "nats") {
  require("./nats-consumer");
} else {
  require("./http-server");
}
