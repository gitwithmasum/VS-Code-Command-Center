const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
);

test('Marketplace keyword count stays within the 30-tag limit', () => {
  assert.ok(Array.isArray(pkg.keywords));
  assert.ok(pkg.keywords.length > 0);
  assert.ok(pkg.keywords.length <= 30);
  assert.equal(new Set(pkg.keywords).size, pkg.keywords.length);
});

test('Marketplace presentation metadata is valid', () => {
  assert.equal(pkg.publisher, 'gitwithmasum');
  assert.equal(pkg.pricing, 'Free');
  assert.equal(typeof pkg.description, 'string');
  assert.ok(pkg.description.length >= 40);
  assert.ok(pkg.description.length <= 200);
  assert.match(pkg.icon || '', /\.png$/i);
  assert.ok(fs.existsSync(path.join(root, pkg.icon)));
  assert.match(pkg.galleryBanner?.color || '', /^#[0-9A-Fa-f]{6}$/);
  assert.ok(['dark', 'light'].includes(pkg.galleryBanner?.theme));
});

test('Marketplace categories use supported values', () => {
  const allowed = new Set([
    'AI',
    'Azure',
    'Chat',
    'Data Science',
    'Debuggers',
    'Extension Packs',
    'Education',
    'Formatters',
    'Keymaps',
    'Language Packs',
    'Linters',
    'Machine Learning',
    'Notebooks',
    'Other',
    'Programming Languages',
    'SCM Providers',
    'Snippets',
    'Testing',
    'Themes',
    'Visualization'
  ]);

  assert.ok(Array.isArray(pkg.categories));
  assert.ok(pkg.categories.length > 0);
  for (const category of pkg.categories) {
    assert.ok(allowed.has(category), 'Unsupported category: ' + category);
  }
});

test('Marketplace documentation files are present', () => {
  for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE', 'SUPPORT.md']) {
    assert.ok(fs.existsSync(path.join(root, file)), file + ' is missing');
  }
});

test('Marketplace navigation metadata points to the repository', () => {
  assert.match(pkg.repository?.url || '', /github\.com\/gitwithmasum\/VS-Code-Command-Center/i);
  assert.match(pkg.homepage || '', /github\.com\/gitwithmasum\/VS-Code-Command-Center/i);
  assert.match(pkg.bugs?.url || '', /github\.com\/gitwithmasum\/VS-Code-Command-Center\/issues/i);
});
