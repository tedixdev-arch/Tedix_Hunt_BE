import swaggerJsdoc from 'swagger-jsdoc';
import { environment } from '../config/environment.js';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'TedixHunt API',
      version: environment.version,
      description:
        'API for TedixHunt, an outdoor location-based treasure-hunt / escape-room competition engine.',
    },
    servers: [{ url: '/', description: 'Current host' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            details: { type: 'array', items: { type: 'object' } },
          },
          required: ['error'],
        },
        AuthTokens: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string', format: 'email' },
            name: { type: 'string' },
            role: { type: 'string', enum: ['creator', 'participant', 'guest'] },
            roles: {
              type: 'array',
              items: { type: 'string', enum: ['participant', 'organizer', 'creator', 'admin'] },
            },
            isGuest: { type: 'boolean' },
            tedixUserId: { type: 'string' },
            organizations: { type: 'array', items: { type: 'string' } },
          },
        },
        Organization: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            owner: { type: 'string' },
            members: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Hunt: {
          type: 'object',
          required: ['id', 'organizationId', 'createdByUserId', 'name', 'status', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            organizationId: { type: 'string', format: 'uuid' },
            createdByUserId: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'published', 'active', 'paused', 'cancelled', 'finished'] },
            country: { type: 'string', nullable: true },
            region: { type: 'string', nullable: true },
            city: { type: 'string', nullable: true },
            startDate: { type: 'string', format: 'date', nullable: true },
            startTime: { type: 'string', example: '10:00:00', nullable: true },
            timezone: { type: 'string', example: 'Europe/Bucharest', nullable: true },
            durationMinutes: { type: 'integer', minimum: 1, nullable: true },
            capacity: { type: 'integer', minimum: 1, nullable: true },
            contactName: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        HuntListItem: {
          allOf: [
            { $ref: '#/components/schemas/Hunt' },
            {
              type: 'object',
              required: ['huntRoles'],
              properties: {
                huntRoles: {
                  type: 'array',
                  items: { type: 'string', enum: ['organizer', 'supervisor'] },
                },
              },
            },
          ],
        },
      },
    },
  },
  apis: ['./src/routes/*.ts', './dist/routes/*.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
