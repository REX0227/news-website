import { db, initializeDatabase } from "../database.js";
initializeDatabase();

const mc = db.prepare("SELECT MIN(computed_at) as mn, MAX(computed_at) as mx, COUNT(*) as cnt FROM macro_comments").get();
console.log("macro_comments:", JSON.stringify(mc));

const ac = db.prepare("SELECT MIN(computed_at) as mn, MAX(computed_at) as mx, COUNT(*) as cnt FROM asset_comments WHERE asset_class='crypto'").get();
console.log("asset_comments:", JSON.stringify(ac));

const jn = db.prepare("SELECT MIN(published_at) as mn, MAX(published_at) as mx, COUNT(*) as cnt FROM jin10_news").get();
console.log("jin10_news:", JSON.stringify(jn));

const da = db.prepare("SELECT date, overall_direction FROM daily_advice ORDER BY date DESC LIMIT 5").all();
console.log("daily_advice:", JSON.stringify(da));
