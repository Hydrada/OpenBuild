import { createDb } from "./db.js";
import { migrate } from "./migrate.js";

const db = await createDb(process.env);
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
await db.close();
