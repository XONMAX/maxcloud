import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { ROUTES, buildSpec } from '../src/openapi/spec';

/** Collect every route Nest will expose from controller metadata. */
function nestRoutes() {
  const controllers: (new (...a: never[]) => unknown)[] = Reflect.getMetadata('controllers', AppModule);
  const out: string[] = [];
  for (const c of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, c) ?? '');
    for (const key of Object.getOwnPropertyNames(c.prototype)) {
      const fn = c.prototype[key];
      const p = Reflect.getMetadata(PATH_METADATA, fn);
      const m = Reflect.getMetadata(METHOD_METADATA, fn);
      if (p === undefined || m === undefined) continue;
      const full = ('/' + [base, p].filter((s) => s && s !== '/').join('/')).replace(/\/+/g, '/').replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/';
      out.push(`${RequestMethod[m].toLowerCase()} ${full}`);
    }
  }
  return out.sort();
}

describe('OpenAPI spec', () => {
  it('documents exactly the routes the API exposes', () => {
    const documented = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(documented).toEqual(nestRoutes());
  });

  it('generates a valid 3.1 document', () => {
    const spec = buildSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(50);
  });
});
