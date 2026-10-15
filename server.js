
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");

const app = express();
const PORT = 3000;
const MONGO_URL = "mongodb://127.0.0.1:27017";
const DB_NAME = "LabEquipmentDB";

let db;
let mongoClient;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const collections = [
    "departments",
    "students",
    "faculty",
    "labs",
    "equipment",
    "suppliers",
    "purchases",
    "issueReturns",
    "maintenance"
];

const idFields = {
    departments: "deptId",
    students: "studentId",
    faculty: "facultyId",
    labs: "labId",
    equipment: "equipmentId",
    suppliers: "supplierId",
    purchases: "purchaseId",
    issueReturns: "transactionId",
    maintenance: "maintenanceId"
};

const numericFields = [
    "capacity", "quantity", "availableQuantity",
    "price", "totalAmount", "cost"
];

function getCollection(name) {
    if (!collections.includes(name)) {
        const error = new Error("Collection not found");
        error.status = 404;
        throw error;
    }
    return db.collection(name);
}

function cleanRecord(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        const error = new Error("A valid record is required");
        error.status = 400;
        throw error;
    }

    const data = {};

    for (const [key, value] of Object.entries(body)) {
        if (key === "_id" || key === "createdAt") continue;
        if (value === undefined || value === null) continue;

        if (typeof value === "string") {
            data[key] = value.trim();
        } else {
            data[key] = value;
        }
    }

    for (const key of numericFields) {
        if (data[key] !== undefined && data[key] !== "") {
            const number = Number(data[key]);

            if (!Number.isFinite(number) || number < 0) {
                const error = new Error(`${key} must be a non-negative number`);
                error.status = 400;
                throw error;
            }

            data[key] = number;
        }
    }

    return data;
}

function isIssued(record) {
    return String(record?.status || "").toLowerCase() === "issued";
}

async function adjustAvailableStock(equipmentId, amount) {
    if (!equipmentId || amount === 0) return;

    const equipment = db.collection("equipment");

    if (amount < 0) {
        const result = await equipment.updateOne(
            {
                equipmentId,
                availableQuantity: { $gte: Math.abs(amount) }
            },
            { $inc: { availableQuantity: amount } }
        );

        if (result.modifiedCount !== 1) {
            const error = new Error(
                "Equipment not found or insufficient available stock"
            );
            error.status = 400;
            throw error;
        }
    } else {
        const result = await equipment.updateOne(
            { equipmentId },
            { $inc: { availableQuantity: amount } }
        );

        if (result.matchedCount !== 1) {
            const error = new Error("Equipment not found");
            error.status = 400;
            throw error;
        }
    }

    const item = await equipment.findOne({ equipmentId });

    if (item && item.availableQuantity > item.quantity) {
        await equipment.updateOne(
            { equipmentId },
            { $set: { availableQuantity: item.quantity } }
        );
    }

    if (item) {
        await equipment.updateOne(
            { equipmentId },
            {
                $set: {
                    status: item.availableQuantity <= 0
                        ? "Unavailable"
                        : "Available"
                }
            }
        );
    }
}

async function applyIssueStockChange(previous, next) {
    const wasIssued = isIssued(previous);
    const willBeIssued = isIssued(next);

    const oldEquipment = previous?.equipmentId;
    const newEquipment = next?.equipmentId;

    if (wasIssued && willBeIssued && oldEquipment === newEquipment) {
        return;
    }

    if (wasIssued && oldEquipment) {
        await adjustAvailableStock(oldEquipment, 1);
    }

    if (willBeIssued && newEquipment) {
        try {
            await adjustAvailableStock(newEquipment, -1);
        } catch (error) {
            // Best-effort rollback if changing an existing transaction fails.
            if (wasIssued && oldEquipment) {
                await adjustAvailableStock(oldEquipment, -1);
            }
            throw error;
        }
    }
}

app.get("/api/collections", (req, res) => {
    res.json(collections);
});

app.get("/api/:collection", async (req, res) => {
    try {
        const records = await getCollection(req.params.collection)
            .find()
            .sort({ createdAt: -1 })
            .toArray();

        res.json(records);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.post("/api/:collection", async (req, res) => {
    try {
        const name = req.params.collection;
        const collection = getCollection(name);
        const data = cleanRecord(req.body);
        const idField = idFields[name];

        if (idField && !data[idField]) {
            return res.status(400).json({
                error: `${idField} is required`
            });
        }

        if (idField && await collection.findOne({ [idField]: data[idField] })) {
            return res.status(409).json({
                error: `${idField} already exists`
            });
        }

        if (name === "equipment") {
            if (data.availableQuantity === undefined) {
                data.availableQuantity = data.quantity || 0;
            }

            if (data.quantity === undefined) {
                return res.status(400).json({
                    error: "Total quantity is required"
                });
            }

            if (data.availableQuantity > data.quantity) {
                return res.status(400).json({
                    error: "Available quantity cannot exceed total quantity"
                });
            }
        }

        if (name === "issueReturns" && isIssued(data)) {
            await adjustAvailableStock(data.equipmentId, -1);
        }

        data.createdAt = new Date();
        data.updatedAt = new Date();

        try {
            const result = await collection.insertOne(data);
            return res.status(201).json({
                message: "Record added successfully",
                id: result.insertedId
            });
        } catch (error) {
            if (name === "issueReturns" && isIssued(data)) {
                await adjustAvailableStock(data.equipmentId, 1);
            }
            throw error;
        }
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.put("/api/:collection/:id", async (req, res) => {
    try {
        const name = req.params.collection;
        const collection = getCollection(name);
        const data = cleanRecord(req.body);

        if (!ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: "Invalid record ID" });
        }

        const _id = new ObjectId(req.params.id);
        const previous = await collection.findOne({ _id });

        if (!previous) {
            return res.status(404).json({ error: "Record not found" });
        }

        const idField = idFields[name];

        if (idField && data[idField]) {
            const duplicate = await collection.findOne({
                [idField]: data[idField],
                _id: { $ne: _id }
            });

            if (duplicate) {
                return res.status(409).json({
                    error: `${idField} already exists`
                });
            }
        }

        if (name === "equipment") {
            const total = data.quantity ?? previous.quantity;
            const available = data.availableQuantity ?? previous.availableQuantity;

            if (available > total) {
                return res.status(400).json({
                    error: "Available quantity cannot exceed total quantity"
                });
            }
        }

        if (name === "issueReturns") {
            const next = { ...previous, ...data };
            await applyIssueStockChange(previous, next);
        }

        data.updatedAt = new Date();

        await collection.updateOne(
            { _id },
            { $set: data }
        );

        res.json({ message: "Record updated successfully" });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.delete("/api/:collection/:id", async (req, res) => {
    try {
        const name = req.params.collection;
        const collection = getCollection(name);

        if (!ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: "Invalid record ID" });
        }

        const _id = new ObjectId(req.params.id);
        const record = await collection.findOne({ _id });

        if (!record) {
            return res.status(404).json({ error: "Record not found" });
        }

        if (name === "issueReturns" && isIssued(record)) {
            await adjustAvailableStock(record.equipmentId, 1);
        }

        await collection.deleteOne({ _id });

        res.json({ message: "Record deleted successfully" });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

async function startServer() {
    try {
        mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();

        db = mongoClient.db(DB_NAME);

        // Enforce uniqueness for new records with the configured IDs.
        for (const [name, field] of Object.entries(idFields)) {
            await db.collection(name).createIndex(
                { [field]: 1 },
                {
                    unique: true,
                    partialFilterExpression: {
                        [field]: { $type: "string" }
                    }
                }
            );
        }

        app.listen(PORT, () => {
            console.log("MongoDB connected successfully!");
            console.log("Database:", DB_NAME);
            console.log(`Server running at http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("Startup failed:", error.message);
        console.error(
            "Check MongoDB is running and existing records do not contain duplicate IDs."
        );
        process.exit(1);
    }
}

startServer();
