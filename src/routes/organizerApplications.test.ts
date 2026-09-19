import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../models/OrganizerApplication.js', () => ({
  OrganizerApplications: { create: mocks.create },
}));

import { createApp } from '../app.js';

const app = createApp();
const validInput = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  organizationName: 'Analytical Academy',
  organizationType: 'school',
  reason: 'Run educational Hunts',
  phone: '+44 1234',
};
const created = {
  id: 'application-1',
  ...validInput,
  status: 'pending',
  createdAt: new Date('2026-09-18T12:00:00.000Z'),
  updatedAt: new Date('2026-09-18T12:00:00.000Z'),
};

describe('POST /api/organizer-applications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue(created);
  });

  it('publicly creates a pending application and returns only public fields', async () => {
    const response = await request(app).post('/api/organizer-applications')
      .send(validInput).expect(201);

    expect(response.body).toEqual({
      id: created.id,
      ...validInput,
      status: 'pending',
      createdAt: created.createdAt.toISOString(),
    });
    expect(response.body).not.toHaveProperty('updatedAt');
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('normalizes email and trims surrounding whitespace', async () => {
    await request(app).post('/api/organizer-applications').send({
      ...validInput,
      name: '  Ada Lovelace  ',
      email: '  ADA@EXAMPLE.COM  ',
      organizationName: '  Analytical Academy  ',
      reason: '  Run educational Hunts  ',
      phone: '  +44 1234  ',
    }).expect(201);

    expect(mocks.create).toHaveBeenCalledWith(validInput);
  });

  it.each([undefined, '', '   ', null])('turns optional phone %p into null', async (phone) => {
    const input: Record<string, unknown> = { ...validInput, phone };
    if (phone === undefined) delete input.phone;
    await request(app).post('/api/organizer-applications').send(input).expect(201);
    expect(mocks.create).toHaveBeenCalledWith({ ...validInput, phone: null });
  });

  it.each([
    ['name', undefined],
    ['email', undefined],
    ['organizationName', undefined],
    ['reason', undefined],
    ['name', '   '],
  ])('rejects invalid required field %s', async (field, value) => {
    const input: Record<string, unknown> = { ...validInput, [field]: value };
    if (value === undefined) delete input[field];
    await request(app).post('/api/organizer-applications').send(input)
      .expect(400, { error: 'invalid_input' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid organization type', async () => {
    await request(app).post('/api/organizer-applications')
      .send({ ...validInput, organizationType: 'company' })
      .expect(400, { error: 'invalid_input' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects client-supplied status so an applicant cannot approve itself', async () => {
    await request(app).post('/api/organizer-applications')
      .send({ ...validInput, status: 'approved' })
      .expect(400, { error: 'invalid_input' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
