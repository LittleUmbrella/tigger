/**
 * Wrapper for bybit-api to handle CommonJS/ESM interop
 * Node.js 24 has stricter ESM/CommonJS interop requirements
 */
import pkg from 'bybit-api';
const { RestClientV5 } = pkg;

export { RestClientV5 };

