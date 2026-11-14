import type { Dict } from './zh';

const en: Dict = {
  'app.title': 'Upstream Channel Availability Panel',
  'app.lang': 'Language',

  'channel.title': 'Channels',
  'channel.add': 'Add channel',
  'channel.edit': 'Edit channel',
  'channel.back': 'Back to list',
  'channel.name': 'Name',
  'channel.namePlaceholder': 'Channel name',
  'channel.baseUrl': 'Base URL',
  'channel.baseUrlPlaceholder': 'https://example.com/v1',
  'channel.insecure': 'Skip TLS verification',
  'channel.insecureHint': 'Applies to probe/catalog/test requests of this channel only (self-signed certs)',
  'channel.enabled': 'Enabled',
  'channel.createdAt': 'Created at',
  'channel.keysCount': 'Keys',
  'channel.save': 'Save',
  'channel.delete': 'Delete',
  'channel.deleteConfirm':
    'This cannot be undone. Delete channel "{{name}}"?',
  'channel.empty': 'No channels yet. Click "Add channel" at the top right to start.',
  'channel.new': 'Add channel',

  'key.title': 'Keys',
  'key.add': 'Add key',
  'key.label': 'Label',
  'key.labelPlaceholder': 'Label',
  'key.key': 'Key',
  'key.enabled': 'Enabled',
  'key.concurrency': 'Concurrency',
  'key.delete': 'Delete',
  'key.save': 'Save keys',
  'key.keepHint': 'Leave empty to keep unchanged',
  'key.empty': 'No keys. Click "Add key" to add one.',
  'key.newKeyEmpty': 'New key must not be empty',

  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.yes': 'Yes',
  'common.no': 'No',

  'error.load': 'Failed to load. Please retry.',
  'error.save': 'Failed to save. Please retry.',
  'error.validation': 'Validation failed: '
};

export default en;
