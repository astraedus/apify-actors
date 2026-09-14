/**
 * The OUTPUT schema is what the Apify Store's publish gate actually requires,
 * and it is a different file from the dataset schema: the dataset schema
 * describes the SHAPE of a row and drives the results table, while this one
 * tells the Console WHERE a finished run left its results.
 *
 * Its templates are resolved by the platform, never by us, so a typo in a
 * placeholder is invisible until a customer looks at a finished run and finds a
 * dead link. These tests pin the placeholders against the documented list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const actorDir = new URL('../.actor/', import.meta.url);

function readJson(name) {
    return JSON.parse(readFileSync(fileURLToPath(new URL(name, actorDir)), 'utf8'));
}

/**
 * Every placeholder the platform substitutes, from the Actor output schema
 * docs. Anything outside this set is passed through verbatim into the Console,
 * which renders a broken link rather than failing loudly.
 */
const LITERAL_PLACEHOLDERS = new Set([
    'links.publicRunUrl',
    'links.consoleRunUrl',
    'links.apiRunUrl',
    'links.apiDefaultDatasetUrl',
    'links.apiDefaultKeyValueStoreUrl',
    'run.containerUrl',
    'run.defaultDatasetId',
    'run.defaultKeyValueStoreId',
]);

/** The two parameterised forms, for a NAMED storage rather than the run's default. */
const NAMED_STORAGE_PLACEHOLDER = /^storages\.(datasets|keyValueStores)\.[^.]+\.apiUrl$/;

function placeholdersIn(template) {
    return [...template.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1].trim());
}

const outputSchema = readJson('output_schema.json');
const actorJson = readJson('actor.json');

test('actor.json points at the output schema, which is the Store publish gate', () => {
    assert.equal(actorJson.output, './output_schema.json');
    // Referencing a file that does not exist fails the BUILD, not the publish,
    // so prove the reference resolves rather than trusting the string.
    assert.ok(readJson('output_schema.json'), 'the referenced file must parse');
});

test('the output schema uses its own version key, not the actor specification one', () => {
    assert.equal(outputSchema.actorOutputSchemaVersion, 1);
    assert.equal(
        'actorSpecification' in outputSchema,
        false,
        'actorSpecification belongs to actor.json and the dataset schema; the output schema has its own key '
            + 'and silently fails validation if given the wrong one',
    );
    assert.equal(typeof outputSchema.title, 'string');
    assert.ok(outputSchema.title.length > 0);
});

test('every output property has a title and a template', () => {
    const properties = outputSchema.properties;
    const names = Object.keys(properties);
    assert.ok(names.length > 0, 'an empty properties object is the same as having no output schema');

    for (const [name, property] of Object.entries(properties)) {
        assert.equal(typeof property.title, 'string', `${name} must have a title`);
        assert.ok(property.title.length > 0, `${name} must have a non-empty title`);
        assert.equal(typeof property.template, 'string', `${name} must have a template`);
    }
});

test('GUARD: every template placeholder is one the platform actually substitutes', () => {
    const properties = outputSchema.properties;
    let checked = 0;

    for (const [name, property] of Object.entries(properties)) {
        const found = placeholdersIn(property.template);
        assert.ok(found.length > 0, `${name}'s template must reference at least one placeholder`);
        for (const placeholder of found) {
            checked += 1;
            assert.ok(
                LITERAL_PLACEHOLDERS.has(placeholder) || NAMED_STORAGE_PLACEHOLDER.test(placeholder),
                `${name} references "{{${placeholder}}}", which is not a documented placeholder. `
                    + `Allowed: ${[...LITERAL_PLACEHOLDERS].join(', ')}, `
                    + 'storages.datasets.<name>.apiUrl, storages.keyValueStores.<name>.apiUrl',
            );
        }
    }

    assert.ok(checked > 0, 'the placeholder check must not pass vacuously');
});

test('the run summary output points at the key the Actor actually writes', () => {
    // main.js writes RUN_SUMMARY to the default key-value store. If that key is
    // ever renamed, this link goes dead with no other symptom.
    const properties = outputSchema.properties;
    const summary = properties.runSummary;
    assert.ok(summary, 'the run summary must be exposed as an output');
    assert.equal(summary.template, '{{links.apiDefaultKeyValueStoreUrl}}/records/RUN_SUMMARY');

    const mainSource = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8');
    assert.match(
        mainSource,
        /Actor\.setValue\(\s*'RUN_SUMMARY'/,
        'main.js must still write the RUN_SUMMARY key this output links to',
    );
});

test('the dataset output points at the items endpoint, not the dataset object', () => {
    const properties = outputSchema.properties;
    const dataset = Object.values(properties).find((p) => p.template.includes('apiDefaultDatasetUrl'));
    assert.ok(dataset, 'the dataset must be exposed as an output');
    assert.equal(
        dataset.template,
        '{{links.apiDefaultDatasetUrl}}/items',
        'without /items the link returns the dataset metadata object rather than the rows',
    );
});
