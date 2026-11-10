import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_STORAGE_ROOT_VERSION, resolveProjectRoot, resolveInsideProject } from '../src/core/project/paths';
import { initProjectConfig, loadProjectConfig, inspectProject, toProviderSet } from '../src/core/project/config';
import { OperationStore } from '../src/core/project/operation-store';
import { CapabilityRegistry } from '../src/core/execution/registry';
import { canonicalize, verifyExecutionHandle } from '../src/core/execution/handle';
import { runCapability } from '../src/core/execution/runtime';
import { createArtProvider } from '../src/providers/art';
import { createSampleProvider } from './helpers/sample-provider';
import { FakeExecutor } from './helpers/fake-executor';
import { fakeBackend } from './helpers/unity-fixtures';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) {
    const rel = path.relative(os.tmpdir(), root);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('unsafe fixture cleanup');
    const link = path.join(root, 'source', '.vant');
    try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'v-cli-storage-'));
  temporary.push(parent);
  const code = path.join(parent, 'dev'), storage = path.join(parent, 'source'), other = path.join(parent, 'other');
  for (const root of [code, storage, other]) fs.mkdirSync(root);
  const project = resolveProjectRoot(code, undefined, { storageRoot: storage });
  return { parent, code, storage, other, project };
}
const artBinding = (workspace = '.vant/art') => ({ workspace, output: `${workspace}/output`, cache: `${workspace}/cache`, projectId: 'project' });
function artRegistry(executor = new FakeExecutor(() => ({ stdout: JSON.stringify({ ok: true }) }))) {
  const registry = new CapabilityRegistry();
  registry.registerProvider(createArtProvider({ executor, discoverBackend: () => fakeBackend({ package: '@kevlns/art-workshop', name: 'art' }) }));
  return { registry, executor };
}

describe('independent project code and owned storage roots', () => {
  it('anchors owned .vant data in storage and rules / business paths in the code checkout', () => {
    const f = fixture();
    expect(PROJECT_STORAGE_ROOT_VERSION).toBe(1);
    for (const relative of ['.vant', '.vant/config/v-cli.json', '.vant/state/operations', '.vant/art', '.vant/video', '.vant/design-runs', '.vant/env', '.vant/future-owned/data'])
      expect(resolveInsideProject(f.project, relative, 'owned').path).toBe(path.join(f.storage, relative));
    for (const relative of ['.', '.vant/rules.md', '.vant/rules', '.vant/rules/review.md', 'Design/request.json', 'Arts/config.json', 'src/main.ts'])
      expect(resolveInsideProject(f.project, relative, 'code').path).toBe(path.join(f.code, relative));
    for (const relative of ['../source/private', '.vant/../private', path.join(f.storage, 'private')])
      expect(() => resolveInsideProject(f.project, relative, 'unsafe')).toThrow();
    expect(() => resolveProjectRoot(f.code, undefined, { storageRoot: path.join(f.parent, 'missing') })).toThrow();
  });

  it('initializes, loads, backs up and inspects only storage config while resolving custom Arts in dev', () => {
    const f = fixture(), { registry } = artRegistry(), providers = toProviderSet(registry.listProviders());
    const result = initProjectConfig(f.project, providers, { art: artBinding('Arts') });
    expect(result.ok).toBe(true);
    expect(result.file).toBe(path.join(f.storage, '.vant/config/v-cli.json'));
    expect(fs.existsSync(path.join(f.code, '.vant'))).toBe(false);
    const loaded = loadProjectConfig(f.project, providers);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw Error('fixture binding missing');
    expect(loaded.resolved.art.dirs.workspace).toBe(path.join(f.code, 'Arts'));
    const prior = fs.readFileSync(result.file, 'utf8');
    const reset = initProjectConfig(f.project, providers, { art: artBinding() }, { reset: true });
    expect(reset.ok).toBe(true);
    if (!reset.ok || !reset.backupPath) throw Error('fixture backup missing');
    expect(reset.backupPath.startsWith(path.join(f.storage, '.vant/state/config-backups'))).toBe(true);
    expect(fs.readFileSync(reset.backupPath, 'utf8')).toBe(prior);
    const inspection = inspectProject(f.project, providers);
    expect(inspection.config.file).toBe(result.file);
    expect(inspection.state.dir).toBe(path.join(f.storage, '.vant/state/operations'));
    expect(inspection.vant.dir).toBe(path.join(f.storage, '.vant'));
    expect(fs.existsSync(path.join(f.code, '.vant'))).toBe(false);
  });

  it('persists both roots and restores the immutable originating handle through the same storage', async () => {
    const f = fixture(), registry = new CapabilityRegistry();
    registry.registerProvider(createSampleProvider());
    initProjectConfig(f.project, toProviderSet(registry.listProviders()));
    const result = await runCapability(registry, { capabilityId: 'sample.trigger', projectRoot: f.code,
      storageRoot: f.storage, operationId: 'original-operation', input: {} });
    expect(result.handle).not.toBeNull();
    expect(result.project).toMatchObject({ root: f.project.realRoot, codeRoot: f.project.realRoot, storageRoot: f.project.realStorageRoot });
    const dir = path.join(f.storage, '.vant/state/operations/original-operation');
    const persisted = fs.readFileSync(path.join(dir, 'result.json'), 'utf8');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'input.json'), 'utf8')).project).toMatchObject({ codeRoot: f.project.realRoot, storageRoot: f.project.realStorageRoot });
    const reopened = resolveProjectRoot(f.other, undefined, { storageRoot: f.storage });
    const checked = verifyExecutionHandle({ project: reopened, handle: result.handle, expectProviderId: 'sample' });
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw Error(checked.errors.join(';'));
    expect(checked.originProject).toEqual(result.handle!.project);
    expect(checked.originProject.codeRoot).toBe(f.project.realRoot);
    expect(resolveInsideProject(reopened, 'src/private.ts', 'code').path).toBe(path.join(f.other, 'src/private.ts'));
    expect(verifyExecutionHandle({ project: resolveProjectRoot(f.other), handle: result.handle, expectProviderId: 'sample' })).toMatchObject({ ok: false, code: 'handle-project-mismatch' });
    expect(() => OperationStore.reserve(reopened, 'original-operation')).toThrow(/已存在/);
    expect(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).toBe(persisted);
    expect(fs.existsSync(path.join(f.code, '.vant'))).toBe(false);
  });

  it('reads an original single-root handle without rewriting its source identity or replaying an unknown operation', async () => {
    const f = fixture(), registry = new CapabilityRegistry();
    registry.registerProvider(createSampleProvider());
    const source = resolveProjectRoot(f.storage);
    initProjectConfig(source, toProviderSet(registry.listProviders()));
    const result = await runCapability(registry, { capabilityId: 'sample.trigger', projectRoot: f.storage, operationId: 'prior-source-operation', input: {} });
    const file = path.join(f.storage, '.vant/state/operations/prior-source-operation/result.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Historical record shape produced before independent storage existed.
    delete raw.project.codeRoot; delete raw.project.storageRoot;
    delete raw.handle.project.codeRoot; delete raw.handle.project.storageRoot;
    const { integrity: _omit, ...base } = raw.handle;
    raw.handle.integrity.digest = createHash('sha256').update(canonicalize(base)).digest('hex');
    raw.execution.status = 'unknown'; raw.execution.lifecycle = 'unknown';
    fs.writeFileSync(file, JSON.stringify(raw));
    const before = fs.readFileSync(file, 'utf8');
    const checked = verifyExecutionHandle({ project: f.project, handle: raw.handle, expectProviderId: 'sample' });
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw Error(checked.errors.join(';'));
    expect(checked.originProject).toEqual({ root: source.realRoot, configFile: result.project.configFile });
    expect(checked.record.execution?.status).toBe('unknown');
    await expect(runCapability(registry, { capabilityId: 'sample.trigger', projectRoot: f.code, storageRoot: f.storage,
      operationId: 'prior-source-operation', input: {} })).rejects.toMatchObject({ structured: { code: 'operation-exists' } });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('passes actual dev cwd and custom Arts paths, storage-owned default art/video paths and controlled input paths to providers', async () => {
    const f = fixture(), { registry, executor } = artRegistry(), providers = toProviderSet(registry.listProviders());
    initProjectConfig(f.project, providers, { art: artBinding('Arts') });
    await runCapability(registry, { capabilityId: 'art.style-import', projectRoot: f.code, storageRoot: f.storage,
      operationId: 'custom-arts', input: { file: 'Design/style.json' } });
    const custom = executor.calls.at(-1)!;
    expect(custom.cwd).toBe(f.code);
    expect(custom.args[custom.args.indexOf('--workspace') + 1]).toBe(path.join(f.code, 'Arts'));
    expect(custom.args[custom.args.indexOf('--file') + 1]).toBe(path.join(f.code, 'Design/style.json'));
    initProjectConfig(f.project, providers, { art: artBinding() }, { reset: true });
    await runCapability(registry, { capabilityId: 'art.style-import', projectRoot: f.code, storageRoot: f.storage,
      operationId: 'owned-art', input: { file: '.vant/design-runs/style.json' } });
    const owned = executor.calls.at(-1)!;
    expect(owned.args[owned.args.indexOf('--workspace') + 1]).toBe(path.join(f.storage, '.vant/art'));
    expect(owned.args[owned.args.indexOf('--file') + 1]).toBe(path.join(f.storage, '.vant/design-runs/style.json'));
    const videoId = registry.list().find(value => value.id === 'art.video-task-list')?.id;
    expect(videoId).toBeDefined();
    await runCapability(registry, { capabilityId: videoId!, projectRoot: f.code, storageRoot: f.storage,
      operationId: 'owned-video', input: {} });
    const video = executor.calls.at(-1)!;
    expect(video.cwd).toBe(f.code);
    expect(video.args[video.args.indexOf('--workspace') + 1]).toBe(f.storage);
    expect(fs.existsSync(path.join(f.code, '.vant'))).toBe(false);
  });

  it('rejects storage junction escape and never follows it into another project', () => {
    const f = fixture();
    fs.symlinkSync(f.other, path.join(f.storage, '.vant'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveInsideProject(f.project, '.vant/config/v-cli.json', 'config')).toThrow(/逃逸/);
    expect(() => OperationStore.reserve(f.project, 'unsafe-operation')).toThrow();
    expect(fs.existsSync(path.join(f.other, 'state/operations'))).toBe(false);
  });
});
