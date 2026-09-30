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
            accountStatus: { type: 'string', enum: ['active', 'blocked', 'retired'] },
            organizations: { type: 'array', items: { type: 'string' } },
          },
        },
        AdminUser: {
          type: 'object',
          required: ['id', 'email', 'roles', 'isGuest', 'accountStatus', 'createdAt', 'activationState'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            name: { type: 'string', nullable: true },
            roles: {
              type: 'array',
              items: { type: 'string', enum: ['participant', 'organizer', 'creator', 'admin'] },
            },
            isGuest: { type: 'boolean' },
            accountStatus: { type: 'string', enum: ['active', 'blocked', 'retired'] },
            createdAt: { type: 'string', format: 'date-time' },
            activationState: { type: 'string', enum: ['not_required', 'pending', 'expired'] },
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
        OrganizerApplication: {
          type: 'object',
          required: ['id', 'name', 'email', 'organizationName', 'organizationType', 'reason', 'phone', 'status', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            organizationName: { type: 'string' },
            organizationType: { type: 'string', enum: ['school', 'ngo', 'community', 'other'] },
            reason: { type: 'string' },
            phone: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['pending'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        CreatorApplication: {
          type: 'object',
          required: ['id', 'userId', 'name', 'email', 'status', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            reviewedAt: { type: 'string', format: 'date-time', nullable: true },
            reviewedBy: { type: 'string', format: 'uuid', nullable: true },
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
        HuntContext: {
          type: 'object',
          required: ['huntId', 'huntName', 'huntStatus', 'participant', 'supervisor'],
          properties: {
            huntId: { type: 'string', format: 'uuid' },
            huntName: { type: 'string' },
            huntStatus: { type: 'string', enum: ['active', 'paused', 'published', 'draft', 'finished', 'cancelled'] },
            participant: { type: 'boolean', description: 'True when the user is enrolled in this Hunt.' },
            supervisor: { type: 'boolean', description: 'True when the user has this Hunt-specific supervisor role.' },
          },
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
        CreatorTemplateContent: {
          type: 'object',
          required: ['key', 'version', 'displayName', 'theme', 'mission', 'configuration', 'scoring', 'checkpoints'],
          properties: {
            key: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
            displayName: { type: 'string', minLength: 1 },
            theme: { type: 'string', minLength: 1 },
            mission: { type: 'object', minProperties: 1, additionalProperties: true },
            configuration: { type: 'object', minProperties: 1, additionalProperties: true },
            scoring: { type: 'object', minProperties: 1, additionalProperties: true },
            checkpoints: { type: 'array', minItems: 1, items: { type: 'object' } },
          },
          additionalProperties: true,
        },
        CreatorOwnedTemplate: {
          type: 'object',
          required: ['key', 'version', 'status', 'origin', 'submittedVersion', 'content'],
          properties: {
            key: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: ['draft', 'submitted', 'changes_requested', 'approved'] },
            origin: { type: 'string', enum: ['creator'] },
            submittedVersion: {
              type: 'integer', minimum: 1, nullable: true,
              description: 'Exact immutable version currently submitted for review, or null.',
            },
            content: { $ref: '#/components/schemas/CreatorTemplateContent' },
          },
        },
        AdminTemplateReview: {
          type: 'object',
          required: ['key', 'version', 'status', 'origin', 'creator', 'content'],
          description: 'Admin review artifact pinned to hunt_templates.submitted_version.',
          properties: {
            key: { type: 'string' },
            version: { type: 'integer', minimum: 1, description: 'Exact immutable submitted_version.' },
            status: { type: 'string', enum: ['submitted', 'approved', 'changes_requested'] },
            origin: { type: 'string', enum: ['creator'] },
            creator: {
              type: 'object', required: ['id', 'name', 'email'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string', nullable: true },
                email: { type: 'string', format: 'email', nullable: true },
              },
            },
            content: { $ref: '#/components/schemas/CreatorTemplateContent' },
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
        RewardDetails: {
          type: 'object',
          required: ['provider', 'kind', 'quantity'],
          properties: {
            provider: { type: 'string', enum: ['organizer', 'tedix_inventory'] },
            kind: { type: 'string', enum: ['physical', 'virtual'] },
            category: { type: 'string', nullable: true, enum: ['achievement', 'digital_certificate', 'profile_badge', 'hunt_passport_collectible', 'partner_digital_benefit'] },
            name: { type: 'string', nullable: true },
            description: { type: 'string', nullable: true },
            quantity: { type: 'integer', minimum: 1 },
          },
        },
        LeaderboardRewardInput: {
          allOf: [
            { $ref: '#/components/schemas/RewardDetails' },
            { type: 'object', required: ['place'], properties: { place: { type: 'integer', minimum: 1, maximum: 50 } } },
          ],
        },
        SpecialAwardInput: {
          allOf: [
            { $ref: '#/components/schemas/RewardDetails' },
            { type: 'object', required: ['definitionKey'], properties: { definitionKey: { type: 'string', description: 'Backend-controlled key from /api/reward-options' } } },
          ],
        },
        LeaderboardReward: {
          allOf: [
            { $ref: '#/components/schemas/LeaderboardRewardInput' },
            { type: 'object', required: ['id', 'huntId'], properties: { id: { type: 'string', format: 'uuid' }, huntId: { type: 'string', format: 'uuid' } } },
          ],
        },
        SpecialAward: {
          allOf: [
            { $ref: '#/components/schemas/SpecialAwardInput' },
            { type: 'object', required: ['id', 'huntId'], properties: { id: { type: 'string', format: 'uuid' }, huntId: { type: 'string', format: 'uuid' } } },
          ],
        },
        HuntRewards: {
          type: 'object', required: ['leaderboard', 'specialAwards'],
          properties: {
            leaderboard: { type: 'array', items: { $ref: '#/components/schemas/LeaderboardReward' } },
            specialAwards: { type: 'array', items: { $ref: '#/components/schemas/SpecialAward' } },
          },
        },
        RewardOptions: {
          type: 'object', required: ['providers', 'kinds', 'virtualCategories', 'specialAwardDefinitions'],
          properties: {
            providers: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string', enum: ['organizer', 'tedix_inventory'] }, label: { type: 'string' } } } },
            kinds: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string', enum: ['physical', 'virtual'] }, label: { type: 'string' } } } },
            virtualCategories: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string', enum: ['achievement', 'digital_certificate', 'profile_badge', 'hunt_passport_collectible', 'partner_digital_benefit'] }, label: { type: 'string' } } } },
            specialAwardDefinitions: { type: 'array', items: { type: 'object', required: ['key', 'scope', 'name', 'rule', 'description', 'eligibility'], properties: { key: { type: 'string' }, scope: { type: 'string', enum: ['team', 'personal'] }, name: { type: 'string' }, rule: { type: 'string' }, description: { type: 'string' }, eligibility: { type: 'string' } } } },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.ts', './dist/routes/*.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
