import { expect, it } from 'vitest';
import { API_PREFIX } from './api';
import { ROUTES, buildOpenApi } from './openapi';

it('documents every route under /api/v1 with converted schemas', () => {
  const doc = buildOpenApi() as any;
  expect(doc.openapi).toBe('3.0.3');
  for (const r of ROUTES) {
    const path = `${API_PREFIX}${r.path.replace(/:(\w+)/g, '{$1}')}`;
    expect(doc.paths[path]?.[r.method], `${r.method} ${path}`).toBeDefined();
  }
  expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/v1/health', '/api/v1/collections/{id}/documents', '/api/v1/conversations/{id}/messages', '/api/v1/usage']));
  const login = doc.paths['/api/v1/auth/login'].post;
  expect(login.requestBody.content['application/json'].schema.properties.email.format).toBe('email');
  expect(doc.paths['/api/v1/documents/{id}'].get.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
  expect(doc.paths['/api/v1/conversations/{id}/messages'].post.responses['200'].content['text/event-stream']).toBeDefined();
  expect(JSON.stringify(doc)).not.toContain('$ref');
});
