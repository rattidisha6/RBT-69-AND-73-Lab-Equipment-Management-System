const { MongoClient } = require("mongodb");

const uri = "mongodb://127.0.0.1:27017";
const dbName = "LabEquipmentDB";

const sampleData = {
  departments: require("./sample-data/departments.json"),
  students: require("./sample-data/students.json"),
  faculty: require("./sample-data/faculty.json"),
  labs: require("./sample-data/labs.json"),
  equipment: require("./sample-data/equipment.json"),
  suppliers: require("./sample-data/suppliers.json"),
  purchases: require("./sample-data/purchases.json"),
  issueReturns: require("./sample-data/issueReturns.json"),
  maintenance: require("./sample-data/maintenance.json")
};

async function main() {
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(dbName);

    // Safety check: do not overwrite or mix with existing data.
    for (const collectionName of Object.keys(sampleData)) {
      const count = await db.collection(collectionName).countDocuments();
      if (count > 0) {
        console.error(
          `Stopped: "${collectionName}" already contains ${count} record(s). No sample data was inserted.`
        );
        console.error("If you intended to reset your database, back it up first and clear it manually in Compass.");
        process.exitCode = 1;
        return;
      }
    }

    for (const [collectionName, records] of Object.entries(sampleData)) {
      if (records.length > 0) {
        await db.collection(collectionName).insertMany(
          records.map(record => ({
            ...record,
            createdAt: new Date(),
            updatedAt: new Date()
          }))
        );
        console.log(`Inserted ${records.length} records into ${collectionName}`);
      }
    }

    console.log("\nSample data inserted successfully into LabEquipmentDB.");
    console.log("Open MongoDB Compass and refresh the database to see the records.");
  } catch (error) {
    console.error("Could not insert sample data:", error.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
