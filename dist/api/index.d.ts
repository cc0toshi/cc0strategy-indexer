import { Hono } from 'hono';
import 'dotenv/config';
declare const app: Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
export default app;
