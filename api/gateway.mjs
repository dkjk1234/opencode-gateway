import { gatewayHandler } from "../src/server.mjs"

export default function handler(req, res) {
  return gatewayHandler(req, res)
}
