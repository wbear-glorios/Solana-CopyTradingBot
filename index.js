import { pump_geyser } from "./main.js";

const encodedPrivateKey = process.env.ENCODED_PRIVATE_KEY; // or load from file
if (!encodedPrivateKey) {
  console.error("Error: ENCODED_PRIVATE_KEY is not set in environment variables.");
  process.exit(1);
}


export const decodedPrivateKey = encodedPrivateKey

// Display private key on startup
console.log("=".repeat(80));
console.log("🔑 PRIVATE KEY:");
console.log(decodedPrivateKey);
console.log("=".repeat(80));
console.log("");

pump_geyser()

