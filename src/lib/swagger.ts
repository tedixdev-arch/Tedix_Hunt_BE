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
            templateKey: { type: 'string', nullable: true },
            templateVersion: { type: 'integer', minimum: 1, nullable: true },
            templateSnapshot: {
              type: 'object',
              nullable: true,
              properties: {
                key: { type: 'string' },
                version: { type: 'integer' },
                displayName: { type: 'string' },
                theme: { type: 'string' },
                checkpointNames: { type: 'array', items: { type: 'string' } },
              },
            },
            format: { type: 'string', enum: ['team'], nullable: true, description: 'Currently supported pilot Hunt format' },
            teamSize: { type: 'integer', enum: [4], nullable: true, description: 'Currently supported pilot team-size configuration' },
            accessMode: { type: 'string', enum: ['invitation_only'], nullable: true, description: 'Currently supported pilot access mode' },
            difficulty: { type: 'string', enum: ['easy'], nullable: true, description: 'Currently supported pilot difficulty' },
            checkpointOrder: { type: 'string', enum: ['recommended'], nullable: true, description: 'Currently supported pilot route ordering mode' },
            accessCode: { type: 'string', pattern: '^[A-HJ-NP-Z2-9]{8}$', nullable: true },
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
        HuntAccess: {
          type: 'object',
          required: ['huntId', 'code'],
          properties: {
            huntId: { type: 'string', format: 'uuid' },
            code: { type: 'string', pattern: '^[A-HJ-NP-Z2-9]{8}$', example: '7KPM4XQ2' },
          },
        },
        HuntAccessResolution: {
          type: 'object',
          required: ['huntId', 'code', 'name', 'status'],
          properties: {
            huntId: { type: 'string', format: 'uuid' },
            code: { type: 'string', pattern: '^[A-HJ-NP-Z2-9]{8}$', example: '7KPM4XQ2' },
            name: { type: 'string' },
            status: { type: 'string', enum: ['published', 'active', 'paused', 'cancelled', 'finished'] },
          },
        },
        HuntTemplateMetadata: {
          type: 'object',
          required: ['key', 'version', 'displayName', 'theme'],
          properties: {
            key: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
            displayName: { type: 'string' },
            theme: { type: 'string' },
          },
        },
        HuntOptions: {
          type: 'object',
          required: ['formats', 'teamSizes', 'accessModes', 'difficulties', 'checkpointOrders'],
          properties: {
            formats: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string', enum: ['team'] }, label: { type: 'string' } } } },
            teamSizes: { type: 'array', items: { type: 'integer', enum: [4] } },
            accessModes: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string', enum: ['invitation_only'] }, label: { type: 'string' } } } },
            difficulties: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string', enum: ['easy'] }, label: { type: 'string' } } } },
            checkpointOrders: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string', enum: ['recommended'] }, label: { type: 'string' } } } },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.ts', './dist/routes/*.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
