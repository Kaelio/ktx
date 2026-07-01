// Seed a representative MongoDB dataset for the ktx connector example.
//
// MongoDB runs this once on first container start (it is mounted into
// /docker-entrypoint-initdb.d). It can also be applied by hand:
//   mongosh "mongodb://localhost:27117" < examples/mongodb/init/seed.js
//
// The shapes here exercise the connector's schema inference end to end:
// scalar BSON types, a nested sub-document, an array, Decimal128, dates, a
// field with more than one type (-> "mixed"), an absent field (-> nullable),
// an ObjectId reference for relationship discovery, and a view (to confirm
// introspection never runs a count command on a view).
const app = db.getSiblingDB('app');

app.users.drop();
app.orders.drop();

app.users.insertMany([
  {
    email: 'ada@example.com',
    age: 31,
    active: true,
    created: new Date('2026-01-04T10:00:00Z'),
    balance: NumberDecimal('120.50'),
    address: { city: 'NY', zip: '10001' },
    tags: ['admin', 'early-access'],
    ref: 'abc',
  },
  {
    email: 'grace@example.com',
    active: false,
    created: new Date('2026-02-11T08:30:00Z'),
    balance: NumberDecimal('0.00'),
    address: { city: 'SF', zip: '94016' },
    tags: [],
    ref: 42, // a second type for this field -> inferred "mixed"
    // age intentionally absent -> inferred nullable
  },
  {
    email: 'linus@example.com',
    age: 27,
    active: true,
    created: new Date('2026-03-01T12:00:00Z'),
    balance: NumberDecimal('9.99'),
    address: { city: 'Austin', zip: '73301' },
    tags: ['beta'],
    ref: null,
  },
]);

const userIds = app.users.find({}, { _id: 1 }).toArray().map((u) => u._id);

app.orders.insertMany([
  { user_id: userIds[0], total: 120.5, status: 'paid', placed: new Date('2026-03-02T09:00:00Z') },
  { user_id: userIds[0], total: 9.99, status: 'pending', placed: new Date('2026-03-05T14:00:00Z') },
  { user_id: userIds[1], total: 50.25, status: 'paid', placed: new Date('2026-03-06T16:00:00Z') },
]);

// A view, to confirm introspection does not issue a count command on it
// (MongoDB rejects count on a view with CommandNotSupportedOnView).
app.createView('active_users', 'users', [{ $match: { active: true } }]);

print('users: ' + app.users.countDocuments());
print('orders: ' + app.orders.countDocuments());
print('collections: ' + app.getCollectionNames().join(', '));
