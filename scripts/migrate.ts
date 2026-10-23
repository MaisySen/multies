import { openSqlite } from "../src/server/db/node";
import { migrate } from "../src/server/db";

const file = process.env.DATABASE_PATH ?? ".data/mymail.db";
const applied = await migrate(openSqlite(file));
console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
