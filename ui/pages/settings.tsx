import { Anchor, Button, Group, NumberInput, Paper, PasswordInput, SimpleGrid, Skeleton, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { ConfigEntry, ConfigWriteAnswer, HealthCheck } from '@ein/api';
import { SaveBar, settingOf, SettingSource, TablerIcon, useViewSave } from '@ein/ui/components';
import { useCommand, useConfig } from '@ein/ui/hooks';
import { VT_PERIODS } from '../../lib/api.ts';

type Period = keyof typeof VT_PERIODS;

/** Each period as the page asks for it. */
const PERIODS: { kind: Period; label: string; about: string }[] = [
  {
    kind: 'departures',
    label: 'Departures',
    about: "A stop's next departures. Each stop on a screen costs a call this often, however many screens show it.",
  },
  {
    kind: 'positions',
    label: 'Vehicles',
    about: 'Where the vehicles on a map are. They report every two or three seconds; between answers they drive on along their tracks.',
  },
  { kind: 'disruptions', label: 'Disruptions', about: "The region's disruptions, one call for every card." },
];

/** The form's draft: each setting's value, but `key` a new key, `''` to keep the one set. */
type Draft = { url: string; key: string } & Record<Period, string>;

/** The host of an address, or the address itself when it is not one. */
const hostOf = (url: string): string => {
  try {
    return new URL(url.trim()).host;
  } catch {
    return url.trim();
  }
};

/** Why a period's value cannot be saved, or nothing when it can. */
const periodProblem = (kind: Period, value: string): string | undefined => {
  const { min, max } = VT_PERIODS[kind];
  const seconds = Number(value);
  return value !== '' && Number.isInteger(seconds) && seconds >= min && seconds <= max ? undefined : `From ${min} to ${max} seconds.`;
};

/** `300` as `5 minutes`, `20` as `20 seconds`. */
const spoken = (seconds: number): string =>
  seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60} minute${seconds === 60 ? '' : 's'}` : `${seconds} second${seconds === 1 ? '' : 's'}`;

/** A check as a line with its mark. */
function Check({ check }: { check: HealthCheck }) {
  return (
    <Group gap='xs' wrap='nowrap' align='flex-start'>
      {check.state === 'ok'
        ? <TablerIcon name='circle-check' size={18} color='var(--mantine-color-green-6)' />
        : <TablerIcon name='alert-triangle' size={18} color={`var(--mantine-color-${check.state === 'fail' ? 'red' : 'yellow'}-6)`} />}
      <Text size='sm'>{check.reason}</Text>
    </Group>
  );
}

/** A setting's label with where its value comes from. */
const Labelled = ({ text, entry }: { text: string; entry: ConfigEntry }) => (
  <Group gap='xs' component='span'>
    {text}
    <SettingSource entry={entry} />
  </Group>
);

/**
 * Västtrafik, a settings view of vasttrafik's (`vasttrafik.settings`, a `settings.views` panel): the
 * key to Västtrafik's open API and its address (`CFG_VASTTRAFIK_KEY`, `CFG_VASTTRAFIK_URL`), how
 * long EiN keeps departures, vehicles and disruptions before it asks again (VT_PERIODS' settings),
 * saved as one; then whether Västtrafik takes the key and answers each API (`vt-status`), asked
 * again after a save. A period set back to its default is unset rather than written, unless the
 * installation gives it another value.
 */
export default function VasttrafikSettings() {
  const config = useConfig('system');
  const checks = useCommand<HealthCheck[]>('vt-status');
  const save = useViewSave();
  const url = settingOf(config.entries, 'CFG_VASTTRAFIK_URL');
  const key = settingOf(config.entries, 'CFG_VASTTRAFIK_KEY');
  const periods = Object.fromEntries(PERIODS.map(({ kind }) => [kind, settingOf(config.entries, VT_PERIODS[kind].key)])) as Record<Period, ConfigEntry | undefined>;
  const loaded = url !== undefined && key !== undefined && PERIODS.every(({ kind }) => periods[kind] !== undefined);

  const saved = useMemo<Draft | undefined>(
    () => loaded ? { url: url.value, key: '', ...Object.fromEntries(PERIODS.map(({ kind }) => [kind, periods[kind]!.value])) as Record<Period, string> } : undefined,
    [loaded, url?.value, ...PERIODS.map(({ kind }) => periods[kind]?.value)],
  );
  const [draft, setDraft] = useState<Draft | undefined>(saved);
  useEffect(() => setDraft(saved), [saved]);

  if (config.loading) return <Skeleton height={320} radius='md' />;
  if (!saved || !key || !url) return <Text c='dimmed'>{config.error?.message ?? 'The Västtrafik settings did not load.'}</Text>;
  if (!draft) return <Skeleton height={320} radius='md' />;

  const change = (next: Partial<Draft>) => {
    save.clear();
    setDraft({ ...draft, ...next });
  };
  const changedPeriods = PERIODS.map(({ kind }) => kind).filter((kind) => draft[kind] !== saved[kind]);
  const dirty = draft.url.trim() !== saved.url || draft.key !== '' || changedPeriods.length > 0;
  const sameHost = hostOf(draft.url) === hostOf(saved.url);
  const keySet = key.source !== 'default';
  const problems = Object.fromEntries(PERIODS.map(({ kind }) => [kind, periodProblem(kind, draft[kind])])) as Record<Period, string | undefined>;
  const addressProblem = /^https?:\/\/[^/\s]+/.test(draft.url.trim()) ? undefined : 'An address starts https://, then the host.';
  const blocked = addressProblem ?? PERIODS.map(({ kind }) => problems[kind]).find(Boolean) ??
    (!sameHost && !draft.key && key.source === 'environment'
      ? "The key in the installation's settings belongs to the address it names there; give this one its own."
      : undefined);

  const write = async (): Promise<ConfigWriteAnswer[]> => {
    // Back to the default it is unset; where the installation gives another value, written.
    const unset = changedPeriods.filter((kind) => Number(draft[kind]) === VT_PERIODS[kind].default && periods[kind]!.source === 'system');
    const values = {
      ...(draft.url.trim() !== saved.url ? { CFG_VASTTRAFIK_URL: draft.url.trim() } : {}),
      ...(draft.key ? { CFG_VASTTRAFIK_KEY: draft.key.trim() } : {}),
      ...Object.fromEntries(changedPeriods.filter((kind) => !unset.includes(kind)).map((kind) => [VT_PERIODS[kind].key, draft[kind]])),
    };
    const answers = Object.keys(values).length ? [await config.saveAll(values)] : [];
    const reset = [
      ...unset.map((kind) => VT_PERIODS[kind].key),
      // Another address without a key of its own: the one set here was the old one's.
      ...(!sameHost && !draft.key && key.source === 'system' ? ['CFG_VASTTRAFIK_KEY'] : []),
    ];
    if (reset.length) answers.push(await config.resetAll(reset));
    return answers;
  };
  const onSave = async () => {
    if (await save.run(write)) setDraft((current) => current && { ...current, key: '' });
    checks.refetch();
  };

  return (
    <Stack gap='lg'>
      <Paper p='md' radius='md' withBorder>
        <Stack gap='sm'>
          <PasswordInput
            label={<Labelled text='Key' entry={key} />}
            description={
              <>
                The authentication key of an application of yours at{' '}
                <Anchor href='https://developer.vasttrafik.se' target='_blank' rel='noreferrer' size='xs'>developer.vasttrafik.se</Anchor>{' '}
                that subscribes to Planera Resa v4, Geografi v3 and Störning v1: its key and secret as base64, as the site shows it, or key:secret. Sent to the address below
                alone, and kept where nobody reads it back.
              </>
            }
            placeholder={sameHost && keySet ? 'Set — type a new one to replace it' : 'None'}
            autoComplete='new-password'
            value={draft.key}
            disabled={save.busy}
            onChange={(event) => change({ key: event.currentTarget.value })}
          />
          <TextInput
            label={<Labelled text='Address' entry={url} />}
            description={`Where Västtrafik's open API answers; ${url.default} unless set.`}
            placeholder={url.default}
            value={draft.url}
            error={addressProblem}
            disabled={save.busy}
            onChange={(event) => change({ url: event.currentTarget.value })}
          />
        </Stack>
      </Paper>

      <Paper p='md' radius='md' withBorder>
        <Stack gap='sm'>
          <div>
            <Text fw={600}>How often Västtrafik is asked</Text>
            <Text size='sm' c='dimmed'>
              EiN keeps each answer this long and gives it to every screen that asks meanwhile; the cards ask again as soon as it is due. Shorter is fresher and costs more
              calls to Västtrafik.
            </Text>
          </div>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing='md'>
            {PERIODS.map(({ kind, label, about }) => {
              const { min, max, default: standard } = VT_PERIODS[kind];
              return (
                <NumberInput
                  key={kind}
                  label={<Labelled text={label} entry={periods[kind]!} />}
                  description={`${about} ${spoken(standard)} unless set.`}
                  suffix=' s'
                  min={min}
                  max={max}
                  allowNegative={false}
                  allowDecimal={false}
                  value={draft[kind] === '' ? '' : Number(draft[kind])}
                  error={problems[kind]}
                  disabled={save.busy}
                  onChange={(value) => change({ [kind]: value === '' ? '' : String(value) })}
                  // The fields side by side line up however long the description above each is.
                  styles={{ root: { display: 'flex', flexDirection: 'column' }, wrapper: { marginTop: 'auto' } }}
                />
              );
            })}
          </SimpleGrid>
        </Stack>
      </Paper>

      <SaveBar save={save} dirty={dirty} blocked={blocked} onCancel={() => setDraft(saved)} onSave={onSave} />

      <Paper p='md' radius='md' withBorder>
        <Stack gap='xs'>
          <Group justify='space-between' wrap='nowrap'>
            <Text fw={600}>Now</Text>
            <Button variant='subtle' size='compact-sm' loading={checks.loading} onClick={() => checks.refetch()}>Check again</Button>
          </Group>
          {checks.data
            ? checks.data.map((check) => <Check key={check.name} check={check} />)
            : checks.loading
            ? <Skeleton height={20} />
            : <Text size='sm' c='dimmed'>{checks.error?.message ?? 'No answer.'}</Text>}
        </Stack>
      </Paper>
    </Stack>
  );
}
