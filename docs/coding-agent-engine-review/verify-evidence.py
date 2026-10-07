#!/usr/bin/env python3
"""Verify frozen source references without installing or executing upstream code."""
import argparse, datetime, hashlib, json, pathlib, re, subprocess, sys, urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
MOODCODE = HERE.parent.parent

def sha(data):
    return hashlib.sha256(data).hexdigest()

def git(root, *args, binary=False):
    result = subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)
    return result if binary else result.decode().strip()

def verify(allow_incomplete=False):
    manifest = json.loads((HERE / 'source-manifest.json').read_text())
    result = {'schemaVersion': 1, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'analysisMode': 'static-source-review', 'upstreamExecution': False,
              'moodcodeEngineSource': manifest['moodcodeEngineSource'], 'repositories': [], 'errors': []}
    if len(manifest['repositories']) != 19:
        result['errors'].append('Expected 19 repositories')
    for entry in manifest['repositories']:
        slug, head, root = entry['slug'], entry['head'], pathlib.Path(entry['path'])
        rec = {'slug': slug, 'head': head, 'references': [], 'licenseFiles': [], 'reportSourceLinks': [], 'errors': []}
        result['repositories'].append(rec)
        try:
            if git(root, 'rev-parse', 'HEAD') != head:
                raise ValueError('Checkout HEAD changed')
            if git(root, 'rev-parse', '--is-shallow-repository') != 'false':
                raise ValueError('Checkout history is shallow')
            if git(root, 'status', '--porcelain'):
                raise ValueError('Reference checkout changed')
            tracked = set(git(root, 'ls-files', '-z').split('\0'))
            for license_entry in entry['licenseFiles']:
                path = root / license_entry['path']
                digest = sha(path.read_bytes())
                if digest != license_entry['sha256']:
                    raise ValueError('License changed: ' + license_entry['path'])
                rec['licenseFiles'].append({'path': license_entry['path'], 'sha256': digest})
            report, evidence = HERE / (slug + '.md'), HERE / (slug + '.evidence.json')
            if not report.exists() or not evidence.exists():
                rec['status'] = 'pending'
                if not allow_incomplete:
                    rec['errors'].append('Report/evidence missing')
                continue
            data = json.loads(evidence.read_text())
            if data['slug'] != slug or data['head'] != head or data['analysisMode'] != 'static-source-review':
                raise ValueError('Evidence identity or review mode does not match')
            if not data.get('repository') or not data.get('limitations'):
                raise ValueError('Repository/limitations missing')
            refs = data['references']
            if not isinstance(refs, list) or len(refs) < 12:
                raise ValueError('Expected at least 12 references')
            ids = set()
            for ref in refs:
                if ref['id'] in ids:
                    raise ValueError('Duplicate reference id: ' + ref['id'])
                ids.add(ref['id'])
                rel = pathlib.PurePosixPath(ref['path'])
                if rel.is_absolute() or '..' in rel.parts or str(rel) not in tracked:
                    raise ValueError('Reference is not a tracked relative path: ' + str(rel))
                path = root / str(rel)
                if path.is_symlink() or not path.is_file():
                    raise ValueError('Reference is not a regular file: ' + str(rel))
                content = path.read_bytes()
                pinned = git(root, 'show', head + ':' + str(rel), binary=True)
                if sha(content) != sha(pinned):
                    raise ValueError('Source does not match frozen commit: ' + str(rel))
                lines = content.splitlines(keepends=True)
                start, end = ref['startLine'], ref['endLine']
                if type(start) is not int or type(end) is not int or not 1 <= start <= end <= len(lines):
                    raise ValueError('Invalid line range: ' + ref['id'])
                if end - start + 1 > 160:
                    raise ValueError('Reference range too broad: ' + ref['id'])
                if not ref.get('claim'):
                    raise ValueError('Reference claim missing: ' + ref['id'])
                file_digest = sha(content)
                range_digest = sha(b''.join(lines[start-1:end]))
                for key in ['fileSha256', 'sha256']:
                    if key in ref and ref[key] != file_digest:
                        raise ValueError('Declared file hash mismatch: ' + ref['id'])
                if 'rangeSha256' in ref and ref['rangeSha256'] != range_digest:
                    raise ValueError('Declared range hash mismatch: ' + ref['id'])
                repository = entry['requestedRepository']
                rec['references'].append({'id': ref['id'], 'path': str(rel), 'startLine': start, 'endLine': end,
                                          'fileSha256': file_digest, 'rangeSha256': range_digest,
                                          'url': f'https://github.com/{repository}/blob/{head}/{rel}#L{start}-L{end}'})
            report_text = report.read_text()
            links = re.findall(r'https://github\.com/([^/\s]+/[^/\s]+)/blob/([0-9a-f]{40})/([^\s)#]+)#L(\d+)(?:-L(\d+))?', report_text)
            for repository, link_head, rel, first, last in links:
                if repository.lower() != entry['requestedRepository'].lower():
                    # References to separate public repositories are outside this checkout proof.
                    continue
                rel = urllib.parse.unquote(rel)
                if link_head != head or rel not in tracked:
                    raise ValueError('Report link is not pinned to tracked source: ' + rel)
                link_content = (root / rel).read_bytes()
                if sha(link_content) != sha(git(root, 'show', head + ':' + rel, binary=True)):
                    raise ValueError('Report-linked source changed: ' + rel)
                first, last = int(first), int(last or first)
                if not 1 <= first <= last <= len(link_content.splitlines()):
                    raise ValueError('Report link line range invalid: ' + rel)
                rec['reportSourceLinks'].append({'path': rel, 'startLine': first, 'endLine': last, 'fileSha256': sha(link_content)})
            candidates = data['candidates']
            if not 3 <= len(candidates) <= 5:
                raise ValueError('Expected 3-5 candidates')
            candidate_ids = set()
            for candidate in candidates:
                for key in ['id', 'title', 'priority', 'cost', 'moodcodeStatus', 'moodcodePaths', 'referenceIds', 'contract', 'validation']:
                    if key not in candidate:
                        raise ValueError('Candidate field missing: ' + key)
                    if not candidate[key]:
                        raise ValueError('Candidate field empty: ' + key)
                if candidate['id'] in candidate_ids:
                    raise ValueError('Duplicate candidate id: ' + candidate['id'])
                candidate_ids.add(candidate['id'])
                if not candidate['referenceIds'] or not set(candidate['referenceIds']).issubset(ids):
                    raise ValueError('Candidate references invalid: ' + candidate['id'])
                for rel in candidate['moodcodePaths']:
                    if not isinstance(rel, str) or pathlib.PurePosixPath(rel).is_absolute() or '..' in pathlib.PurePosixPath(rel).parts or not (MOODCODE / rel).exists():
                        raise ValueError('Moodcode path missing: ' + str(rel))
            rec.update(status='verified', reportSha256=sha(report.read_bytes()), evidenceSha256=sha(evidence.read_bytes()), candidateCount=len(candidates))
        except Exception as error:
            rec['status'] = 'failed'
            rec['errors'].append(str(error))
        result['errors'].extend(slug + ': ' + error for error in rec['errors'])
    baseline = json.loads((HERE / 'moodcode-baseline.evidence.json').read_text())
    baseline_pins = []
    for ref in baseline['references']:
        try:
            path = MOODCODE / ref['path']
            content = path.read_bytes()
            pinned = git(MOODCODE, 'show', baseline['head'] + ':' + ref['path'], binary=True)
            lines = content.splitlines(keepends=True)
            if sha(content) != sha(pinned) or sha(content) != ref['fileSha256'] or sha(b''.join(lines[ref['startLine']-1:ref['endLine']])) != ref['rangeSha256']:
                raise ValueError('Moodcode baseline changed: ' + ref['id'])
            baseline_pins.append(ref['id'])
        except Exception as error:
            result['errors'].append(str(error))
    result['moodcodeBaselineReferenceCount'] = len(baseline_pins)
    changed = git(MOODCODE, 'diff', '--name-only', manifest['moodcodeHead'], '--', 'packages', 'apps', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json')
    result['productionChanges'] = changed.splitlines() if changed else []
    untracked = git(MOODCODE, 'ls-files', '--others', '--exclude-standard', '--', 'packages', 'apps', 'scripts')
    result['productionUntracked'] = untracked.splitlines() if untracked else []
    if result['productionChanges'] or result['productionUntracked']:
        result['errors'].append('Production/runtime files changed during source review')
    result['verifiedRepositories'] = sum(r.get('status') == 'verified' for r in result['repositories'])
    result['referenceCount'] = sum(len(r['references']) for r in result['repositories'])
    result['reportSourceLinkCount'] = sum(len(r['reportSourceLinks']) for r in result['repositories'])
    result['candidateCount'] = sum(r.get('candidateCount', 0) for r in result['repositories'])
    result['licenseFileCount'] = sum(len(r['licenseFiles']) for r in result['repositories'])
    if not allow_incomplete:
        try:
            sessions = json.loads((HERE / 'analysis-sessions.json').read_text())['projects']
            expected_slugs = {r['slug'] for r in manifest['repositories']}
            if len(sessions) != 19 or {s['slug'] for s in sessions} != expected_slugs:
                raise ValueError('Analysis session registry scope differs from manifest')
            if any(s['state'] != 'complete' or not s.get('agent') for s in sessions):
                raise ValueError('Per-project analysis session incomplete')
            catalogue = json.loads((HERE / 'candidate-catalogue.json').read_text())
            if catalogue['status'] != 'complete' or catalogue['reviewedProjects'] != 19 or catalogue['implementedByThisReview'] is not False:
                raise ValueError('Candidate catalogue completion/scope mismatch')
            expected = []
            for entry in manifest['repositories']:
                data = json.loads((HERE / (entry['slug'] + '.evidence.json')).read_text())
                expected.extend({'sourceSlug': entry['slug'], 'sourceHead': entry['head'],
                                 'report': entry['slug'] + '.md', **c} for c in data['candidates'])
            if catalogue['candidates'] != expected:
                raise ValueError('Candidate catalogue differs from per-project evidence')
            for page in HERE.glob('*.md'):
                for target in re.findall(r'\]\(([^)]+)\)', page.read_text()):
                    if '://' in target or target.startswith('#'):
                        continue
                    target_path = urllib.parse.unquote(target.split('#', 1)[0]).strip('<>')
                    line_suffix = re.fullmatch(r'(.+):(\d+)', target_path)
                    if line_suffix:
                        target_path = line_suffix.group(1)
                    if target_path and not (page.parent / target_path).exists():
                        raise ValueError('Broken local report link: ' + page.name + ' -> ' + target)
                    if line_suffix:
                        linked_file = page.parent / target_path
                        line_number = int(line_suffix.group(2))
                        if not linked_file.is_file() or not 1 <= line_number <= len(linked_file.read_bytes().splitlines()):
                            raise ValueError('Invalid local file line: ' + page.name + ' -> ' + target)
            result['sessionRegistryVerified'] = True
            result['candidateCatalogueVerified'] = True
            result['localDocumentLinksVerified'] = True
        except Exception as error:
            result['errors'].append(str(error))
    result['status'] = 'failed' if result['errors'] else ('complete' if result['verifiedRepositories'] == 19 else 'in-progress')
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-incomplete', action='store_true')
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    result = verify(args.allow_incomplete)
    payload = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(payload)
    print(json.dumps({k: result[k] for k in ['status', 'verifiedRepositories', 'referenceCount', 'reportSourceLinkCount', 'candidateCount', 'licenseFileCount', 'errors']}, ensure_ascii=False))
    sys.exit(1 if result['errors'] else 0)
