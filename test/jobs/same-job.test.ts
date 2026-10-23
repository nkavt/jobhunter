import { describe, expect, it } from 'vitest';
import { groupSameJobs, sameJobKey, withAllLocations, type Job } from '../../src/jobs/index.js';

const job = (id: string, title: string, place?: string, patch: Partial<Job> = {}): Job => ({
  source: 'greenhouse',
  sourceId: id,
  url: `https://boards.greenhouse.io/bjak/jobs/${id}`,
  title,
  company: 'Bjak',
  location: place ? { text: place, regions: place.split(', ') } : { regions: [] },
  description: 'Build things.',
  tags: [],
  ...patch,
});

describe('same job in several locations', () => {
  it('takes place names and work modes out of the title', () => {
    const key = sameJobKey(job('1', 'Lead Engineer - Vietnam', 'Vietnam'));
    expect(sameJobKey(job('2', 'Lead Engineer (Singapore)', 'Singapore'))).toBe(key);
    expect(sameJobKey(job('3', 'Lead Engineer | Taipei, Taiwan | Remote', 'Taipei, Taiwan'))).toBe(
      key,
    );
    expect(sameJobKey(job('4', 'Lead Engineer', 'United States'))).toBe(key);
  });

  it('keeps apart other titles, companies and sources', () => {
    const key = sameJobKey(job('1', 'Lead Engineer - Vietnam', 'Vietnam'));
    expect(sameJobKey(job('2', 'Lead Engineer - Travel FX App', 'Vietnam'))).not.toBe(key);
    expect(sameJobKey(job('3', 'Lead Engineer', 'Vietnam', { company: 'Acme' }))).not.toBe(key);
    expect(sameJobKey(job('4', 'Lead Engineer', 'Vietnam', { source: 'lever' }))).not.toBe(key);
  });

  it('groups in order, led by a remote copy when there is one', () => {
    const vietnam = job('vn', 'Lead Engineer - Vietnam', 'Vietnam', { workMode: 'hybrid' });
    const germany = job('de', 'Lead Engineer - Germany', 'Germany', { workMode: 'remote' });
    const other = job('pm', 'Product Engineer', 'Germany');
    const groups = groupSameJobs([vietnam, other, germany], (item) => item);
    expect(groups).toEqual([
      { first: germany, others: [vietnam] },
      { first: other, others: [] },
    ]);
  });

  it('shows the AI every location, each with its work mode', () => {
    const germany = job('de', 'Lead Engineer - Germany', 'Germany', { workMode: 'remote' });
    const tokyo = job('jp', 'Lead Engineer - Tokyo', 'Tokyo, Japan', { workMode: 'hybrid' });
    const anywhere = job('ww', 'Lead Engineer', undefined, {
      location: { worldwide: true, regions: [] },
    });
    const seen = withAllLocations({ first: germany, others: [tokyo, anywhere] });
    expect(seen.location).toEqual({
      text: 'Germany (remote); Tokyo, Japan (hybrid); anywhere',
      regions: ['Germany', 'Tokyo', 'Japan'],
    });
    expect(seen.workMode).toBeUndefined();
    expect(seen.url).toBe(germany.url);
    expect(withAllLocations({ first: germany, others: [] })).toBe(germany);
  });
});
