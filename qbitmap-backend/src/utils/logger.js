/**
 * Structured Logger using Pino
 * - JSON format in production
 * - Pretty format in development
 */
const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isProduction
    ? {
        // Production: JSON format for log aggregation
        formatters: {
          level: (label) => ({ level: label })
        }
      }
    : {
        // Development: Pretty print
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname'
          }
        }
      }
  )
});

// Create child loggers for different modules
logger.child = logger.child.bind(logger);

module.exports = logger;
