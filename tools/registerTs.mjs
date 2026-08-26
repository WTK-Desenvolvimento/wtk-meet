/**
 * Alvo do `--import` dos scripts `test`. Existe só porque a flag precisa de um
 * módulo que chame `register()` — o hook em si mora em `tsLoader.mjs`.
 */
import { register } from 'node:module';

register('./tsLoader.mjs', import.meta.url);
