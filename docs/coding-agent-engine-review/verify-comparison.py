#!/usr/bin/env python3
"""Verify the pinned 19-repository comparison and its proposed work breakdown; read-only except --output."""
import argparse
import collections
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]

def git(*args):
    return subprocess.check_output(['git', '-C', str(REPO), *args])

def digest(data):
    return hashlib.sha256(data).hexdigest()

def load(name):
    return json.loads((ROOT / name).read_text())

def verify():
    errors = []
    def check(condition, message):
        if not condition:
            errors.append(message)
    comparison = load('one-to-one-comparison.json')
    manifest = load('source-manifest.json')
    evidence = load('comparison-evidence.json')
    catalogue = load('candidate-catalogue.json')
    work = load('implementation-work-items.json')
    head = comparison['moodcodeHead']
    source = comparison['moodcodeEngineSource']
    check(head == evidence['head'] == work['moodcodeHead'], 'Moodcode HEAD mismatch')
    check(subprocess.call(['git', '-C', str(REPO), 'merge-base', '--is-ancestor', manifest['moodcodeHead'], head]) == 0, 'original analysis baseline is not an ancestor')
    check(source == manifest['moodcodeEngineSource'] == evidence['engineSource'], 'engine source mismatch')
    check(comparison['analysisMode'] == 'static-source-comparison', 'unexpected comparison mode')
    check(comparison['implementedByThisDocument'] is False and work['implementedByThisDocument'] is False, 'proposal marked implemented')
    check(evidence['upstreamExecution'] is False, 'unexpected upstream execution claim')
    refs = {x['id']: x for x in evidence['references']}
    check(len(refs) == len(evidence['references']) == 35, 'expected 35 unique local references')
    pinned = []
    for ref in evidence['references']:
        try:
            path = REPO / ref['path']
            data = path.read_bytes()
            baseline = git('show', head + ':' + ref['path'])
            engine = git('show', source + ':' + ref['path'])
            lines = data.splitlines(keepends=True)
            first, last = ref['startLine'], ref['endLine']
            check(1 <= first <= last <= len(lines), ref['id'] + ': invalid range')
            check(data == baseline == engine, ref['id'] + ': pinned/current/source differs')
            file_hash = digest(data)
            range_hash = digest(b''.join(lines[first-1:last]))
            check(file_hash == ref['fileSha256'] and range_hash == ref['rangeSha256'], ref['id'] + ': hash mismatch')
            pinned.append({'id': ref['id'], 'path': ref['path'], 'startLine': first, 'endLine': last, 'fileSha256': file_hash, 'rangeSha256': range_hash})
        except (OSError, KeyError, subprocess.CalledProcessError) as exc:
            errors.append(ref['id'] + ': ' + str(exc))
    repositories = {x['slug']: x for x in manifest['repositories']}
    projects = {x['slug']: x for x in comparison['projects']}
    check(len(projects) == len(comparison['projects']) == len(repositories) == 19 and set(projects) == set(repositories), '19 project coverage mismatch')
    axes = {x['id']: x for x in comparison['axes']}
    check(len(axes) == len(comparison['axes']) == 14, '14 unique axes required')
    original = {x['id']: x for x in catalogue['candidates']}
    mappings = {x['candidateId']: x for x in comparison['candidateMappings']}
    families = {x['id']: x for x in comparison['implementationFamilies']}
    check(len(original) == len(mappings) == len(comparison['candidateMappings']) == 75 and set(mappings) == set(original), '75 candidate coverage mismatch')
    check(len(families) == len(comparison['implementationFamilies']) == 20 and set(families) == {'MC2-' + str(i).zfill(2) for i in range(1, 21)}, '20 family coverage mismatch')
    upstream_refs = {}
    comparison_count = 0
    row_candidate_counts = collections.Counter()
    for slug, project in projects.items():
        repository = repositories[slug]
        source_evidence = load(slug + '.evidence.json')
        upstream_refs[slug] = {x['id'] for x in source_evidence['references']}
        check(project['head'] == repository['head'] == source_evidence['head'], slug + ': source HEAD mismatch')
        check(project['repository'] == repository['requestedRepository'] and project['license'] == repository['declaredRootLicense'], slug + ': manifest mismatch')
        rows = project['comparisons']
        comparison_count += len(rows)
        check(len(rows) == 14 and {x['axisId'] for x in rows} == set(axes), slug + ': axis coverage mismatch')
        for row in rows:
            label = slug + '/' + row['axisId']
            check(row['assessment'] in comparison['assessmentDefinitions'], label + ': unknown assessment')
            check(row['sourceCondition'] in {'확인', '조건부', '실험', '역사', '외부', '미확인'}, label + ': unknown source condition')
            check(set(row['upstreamReferenceIds']) <= upstream_refs[slug], label + ': source reference missing')
            check(bool(row['upstreamReferenceIds']) or row['sourceCondition'] == '미확인', label + ': claim without evidence')
            check(bool(row['moodcodeReferenceIds']) and set(row['moodcodeReferenceIds']) <= set(refs), label + ': local reference missing')
            for field in ['upstream', 'moodcode', 'improvement']:
                check(bool(row[field].strip()), label + ': empty ' + field)
            check(set(row['implementationIds']) <= set(families), label + ': unknown implementation family')
            check(set(row['runtimeValidationDebt']) <= {x['id'] for x in comparison['environmentDebts']}, label + ': unknown environment debt')
            for candidate in row['candidateIds']:
                row_candidate_counts[candidate] += 1
                check(candidate in mappings and mappings[candidate]['sourceSlug'] == slug, label + ': foreign/missing candidate')
                if candidate in mappings:
                    check(mappings[candidate]['implementationId'] in row['implementationIds'], label + ': candidate family omitted')
    check(comparison_count == 266, 'expected 266 comparisons')
    check(set(row_candidate_counts) == set(mappings) and all(n == 1 for n in row_candidate_counts.values()), 'candidate comparison coverage duplicated/omitted')
    path_proofs = {}
    for cid, mapping in mappings.items():
        old = original[cid]
        label = cid + ': '
        for old_key, new_key in [('sourceSlug', 'sourceSlug'), ('sourceHead', 'sourceHead'), ('title', 'title'), ('priority', 'originalPriority'), ('cost', 'originalCost'), ('moodcodeStatus', 'currentMoodcode'), ('moodcodePaths', 'existingMoodcodePaths'), ('referenceIds', 'upstreamReferenceIds'), ('contract', 'independentContract'), ('validation', 'acceptance')]:
            check(mapping[new_key] == old[old_key], label + 'original field changed: ' + old_key)
        check(mapping['sourceHead'] == repositories[mapping['sourceSlug']]['head'], label + 'source HEAD mismatch')
        check(set(mapping['upstreamReferenceIds']) <= upstream_refs[mapping['sourceSlug']], label + 'source reference missing')
        check(mapping['moodcodeReferenceIds'] and set(mapping['moodcodeReferenceIds']) <= set(refs), label + 'local reference missing')
        check(mapping['implemented'] is False and mapping['implementationId'] in families, label + 'invalid proposal status/family')
        for path in mapping['existingMoodcodePaths']:
            if path in path_proofs:
                continue
            try:
                data = (REPO / path).read_bytes()
                check(data == git('show', head + ':' + path), path + ': changed candidate baseline')
                path_proofs[path] = digest(data)
            except (OSError, subprocess.CalledProcessError) as exc:
                errors.append(path + ': ' + str(exc))
    grouped = collections.Counter()
    work_families = {x['id']: x for x in work['families']}
    work_ids = []
    check(len(work_families) == len(work['families']) == 20 and set(work_families) == set(families), 'work family coverage mismatch')
    for fid, family in families.items():
        check(family['implemented'] is False, fid + ': marked implemented')
        check(family['proposedApis'] and family['proposedRecords'], fid + ': missing API/record proposal')
        check(set(family['axisIds']) <= set(axes), fid + ': unknown axis')
        for cid in family['candidateIds']:
            grouped[cid] += 1
            check(cid in mappings and mappings[cid]['implementationId'] == fid, fid + ': candidate belongs elsewhere')
        wf = work_families.get(fid, {})
        for key in family:
            check(wf.get(key) == family[key], fid + ': work metadata differs: ' + key)
        check(wf.get('status') == 'proposed', fid + ': invalid work status')
        for key in ['dependency', 'proposedModule', 'persistence', 'contract']:
            check(bool(wf.get(key)), fid + ': empty ' + key)
        expected = {fid + suffix for suffix in 'abcd'}
        tasks = wf.get('workItems', [])
        check(len(tasks) == 4 and {x['id'] for x in tasks} == expected, fid + ': missing four work items')
        for item in tasks:
            work_ids.append(item['id'])
            check(item['status'] == 'proposed' and item['completion'], item['id'] + ': incomplete definition')
    check(set(grouped) == set(mappings) and all(x == 1 for x in grouped.values()), 'candidate family grouping duplicated/omitted')
    check(len(work_ids) == len(set(work_ids)) == 80, 'expected 80 unique proposed work items')
    debts = comparison['environmentDebts']
    check(len(debts) == 4 and {x['id'] for x in debts} == {'E5-13', 'E5-08', 'E6-07', 'E6-08'} and all(x['state'] == 'open' for x in debts), 'original environment debts changed')
    md = (ROOT / 'one-to-one-comparison.md').read_text()
    blueprint = (ROOT / 'implementation-blueprint.md').read_text()
    emd = (ROOT / 'comparison-evidence.md').read_text()
    table_rows = re.findall(r'^\| .*? · \*\*(기구현|부분|추가|검증대기|범위제한)\*\* \|', md, re.M)
    check(len(table_rows) == 266, 'Markdown does not contain 266 comparison rows')
    for project in comparison['projects']:
        check('<a id="' + project['slug'] + '"></a>' in md, project['slug'] + ': missing Markdown section')
        for row in project['comparisons']:
            # The Markdown rendering must preserve the JSON observations and implementation deltas.
            check(row['upstream'].replace('|', '\\|') in md and row['improvement'].replace('|', '\\|') in md, project['slug'] + '/' + row['axisId'] + ': Markdown/JSON differs')
    for mapping in mappings.values():
        check(mapping['candidateId'] in md, mapping['candidateId'] + ': missing Markdown candidate')
    for ref in refs:
        check('<a id="' + ref.lower() + '"></a>' in emd, ref + ': missing local evidence anchor')
    for fid in families:
        check('<a id="' + fid.lower() + '"></a>' in blueprint, fid + ': missing blueprint section')
        for suffix in 'abcd':
            check(fid[-2:] + suffix in blueprint, fid + suffix + ': missing blueprint task')
    # Check local links including explicit anchors and real :line file references in the new documents.
    checked_links = 0
    for filename in ['one-to-one-comparison.md', 'implementation-blueprint.md', 'comparison-evidence.md']:
        for raw in re.findall(r'\]\(([^)]+)\)', (ROOT / filename).read_text()):
            target = unquote(raw.strip('<>'))
            if re.match(r'^(https?://|codex:|app:)', target):
                continue
            file_part, _, anchor = target.partition('#')
            match = re.match(r'^(.*):(\d+)$', file_part)
            line = int(match.group(2)) if match else None
            if match:
                file_part = match.group(1)
            linked = (ROOT / filename) if not file_part else Path(file_part)
            if not linked.is_absolute():
                linked = ROOT / linked
            check(linked.is_file(), filename + ': missing link ' + target)
            if linked.is_file():
                if line:
                    check(1 <= line <= len(linked.read_bytes().splitlines()), filename + ': invalid line link ' + target)
                if anchor:
                    check('<a id="' + anchor + '"></a>' in linked.read_text(), filename + ': missing explicit anchor ' + target)
            checked_links += 1
    production = git('diff', '--name-only', source, '--', 'apps', 'packages', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json').decode().splitlines()
    untracked = git('ls-files', '--others', '--exclude-standard', '--', 'apps', 'packages', 'scripts').decode().splitlines()
    check(not production and not untracked, 'production baseline changed')
    return {
        'schemaVersion': 1, 'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'status': 'complete' if not errors else 'failed',
        'moodcodeHead': head, 'moodcodeEngineSource': source,
        'analysisMode': 'static-source-comparison', 'upstreamExecution': False, 'engineExecution': False,
        'counts': {'projects': len(projects), 'axes': len(axes), 'comparisons': comparison_count,
                   'candidateMappings': len(mappings), 'implementationFamilies': len(families),
                   'proposedWorkItems': len(work_ids), 'localReferences': len(pinned),
                   'candidateBaselinePaths': len(path_proofs), 'checkedLocalLinks': checked_links,
                   'openEnvironmentDebts': len(debts)},
        'localReferences': pinned, 'candidateBaselinePathHashes': path_proofs,
        'productionChanges': production, 'productionUntracked': untracked,
        'errors': errors,
        'limitations': ['Structural/source evidence checks do not prove semantic parity or runtime behavior.',
                        'Original upstream evidence is separately verified by verify-evidence.py.',
                        'No engine tests, live provider calls, OS matrix, GUI, or benchmarks executed by this checker.']
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = verify()
    if args.output:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'counts': result['counts'], 'errors': result['errors']}, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'complete' else 1

if __name__ == '__main__':
    sys.exit(main())
