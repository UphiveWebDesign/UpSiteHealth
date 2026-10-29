// `node --experimental-transform-types --import ./scripts/ts-loader/register.mjs <script>.ts`
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
