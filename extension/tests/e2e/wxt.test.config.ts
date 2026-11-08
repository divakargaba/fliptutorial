import { defineConfig } from 'wxt';
import config from '../../wxt.config';

// A normal developer build must not replace the bundle under a running MV3 test.
export default defineConfig({ ...config, outDir: '.output/e2e' });
