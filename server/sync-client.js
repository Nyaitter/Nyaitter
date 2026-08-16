#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const config = require('./config');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PAGE_DIR = path.join(PROJECT_ROOT, 'page');

function toRepositoryUrl(repository) {
    const value = String(repository || '').trim();
    if (!value) throw new Error('client.repository must not be empty');

    if (/^(https?|ssh):\/\//.test(value) || value.startsWith('git@')) {
        return value;
    }

    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
        throw new Error(
            'client.repository must be an owner/repository value or a Git URL',
        );
    }

    return `https://github.com/${value}.git`;
}

function runGit(args, options = {}) {
    const result = spawnSync('git', args, {
        cwd: options.cwd || PROJECT_ROOT,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
        },
        encoding: 'utf8',
        stdio: options.capture ? 'pipe' : 'inherit',
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = options.capture
            ? (result.stderr || result.stdout || '').trim()
            : '';
        throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }

    return options.capture ? result.stdout.trim() : '';
}

function normalizeGitUrl(url) {
    return String(url || '')
        .trim()
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/\.git$/, '')
        .replace(/\/$/, '')
        .toLowerCase();
}

function isGitRepository(directory) {
    if (!fs.existsSync(directory)) return false;
    try {
        return (
            runGit(['-C', directory, 'rev-parse', '--is-inside-work-tree'], {
                capture: true,
            }) === 'true'
        );
    } catch (_) {
        return false;
    }
}

function main() {
    const repository = config.client?.repository || 'Nyaitter/Client';
    const repositoryUrl = toRepositoryUrl(repository);

    if (!fs.existsSync(PAGE_DIR)) {
        console.log(`[client-sync] Cloning ${repositoryUrl} into page/`);
        runGit(['clone', repositoryUrl, PAGE_DIR]);
        return;
    }

    if (!isGitRepository(PAGE_DIR)) {
        throw new Error(
            'page/ already exists but is not a Git repository. Move or remove it before running client sync.',
        );
    }

    const originUrl = runGit(['-C', PAGE_DIR, 'remote', 'get-url', 'origin'], {
        capture: true,
    });
    if (normalizeGitUrl(originUrl) !== normalizeGitUrl(repositoryUrl)) {
        throw new Error(
            `page/ origin (${originUrl}) does not match client.repository (${repositoryUrl}).`,
        );
    }

    console.log(`[client-sync] Updating page/ from ${repositoryUrl}`);
    runGit(['-C', PAGE_DIR, 'pull', '--ff-only']);
}

try {
    main();
} catch (error) {
    console.error(`[client-sync] ${error.message}`);
    process.exitCode = 1;
}
