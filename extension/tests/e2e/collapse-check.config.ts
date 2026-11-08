import config from '../../playwright.config';
export default { ...config, webServer: undefined, use: { ...config.use, baseURL: 'http://127.0.0.1:4174' } };
