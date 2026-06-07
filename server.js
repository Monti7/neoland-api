const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer'); 
const path = require('path');
const fs = require('fs');

const app = express();

// --- 1. Middleware Settings ---

app.use(cors()); 

// Skip ngrok browser warning page
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

app.use(express.json()); 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve uploads directory
app.use('/uploads', express.static('uploads', {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
}));

if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// --- 2. Multer storage settings for images ---
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- 3. Neon PostgreSQL database pool configuration ---
const connectionString = 'postgresql://neondb_owner:npg_7u1UWSTGMCbI@ep-raspy-scene-aq76emu3.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require';
const pool = new Pool({
    connectionString: connectionString,
    ssl: {
        rejectUnauthorized: false
    }
});

// Auto-create database tables on startup
async function initializeDatabase() {
    try {
        console.log("🔄 Initializing PostgreSQL database tables on Neon...");
        
        // 1. AppSettings table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS AppSettings (
                Id INT PRIMARY KEY,
                SplashBgUrl TEXT NULL,
                UseCustomSplash INT DEFAULT 0
            )
        `);
        
        // Insert default row if AppSettings is empty
        const settingsCheck = await pool.query("SELECT COUNT(*) FROM AppSettings");
        if (parseInt(settingsCheck.rows[0].count) === 0) {
            await pool.query("INSERT INTO AppSettings (Id, SplashBgUrl, UseCustomSplash) VALUES (1, NULL, 0)");
            console.log("✅ Inserted default AppSettings row.");
        }

        // 2. DeletedPropertiesLog table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS DeletedPropertiesLog (
                Id SERIAL PRIMARY KEY,
                PropertyId INT NULL,
                TitleAr TEXT NULL,
                TitleEn TEXT NULL,
                Reason TEXT NULL,
                DeletedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3. Properties table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Properties (
                Id SERIAL PRIMARY KEY,
                TitleAr TEXT NULL,
                TitleEn TEXT NULL,
                Price NUMERIC(18, 2) NULL,
                AreaAr TEXT NULL,
                AreaEn TEXT NULL,
                TypeAr TEXT NULL,
                TypeEn TEXT NULL,
                ProjectAr TEXT NULL,
                ProjectEn TEXT NULL,
                Rooms TEXT NULL,
                DescAr TEXT NULL,
                DescEn TEXT NULL,
                ImageUrl TEXT NULL,
                Images TEXT NULL,
                IsVisible INT DEFAULT 1,
                IsSpecialOffer INT DEFAULT 0,
                CreatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 4. Leads table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Leads (
                Id SERIAL PRIMARY KEY,
                Name TEXT NULL,
                Phone TEXT NULL,
                Method TEXT NULL,
                CreatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log("✅ PostgreSQL Database initialized successfully!");
    } catch (err) {
        console.error("❌ Error initializing database tables: ", err.message);
    }
}

initializeDatabase();

// --- 4. Helper functions for Image URLs ---

function getSingleFullUrl(req, pathStr) {
    if (!pathStr) return "";
    
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const currentHostUrl = `${protocol}://${host}`;

    if (pathStr.startsWith('http://') || pathStr.startsWith('https://')) {
        try {
            const urlObj = new URL(pathStr);
            return `${currentHostUrl}${urlObj.pathname}`;
        } catch (e) {
            return pathStr;
        }
    }
    
    if (pathStr.startsWith('uploads/')) {
        return `${currentHostUrl}/${pathStr}`;
    }
    if (pathStr.startsWith('/uploads/')) {
        return `${currentHostUrl}${pathStr}`;
    }
    
    return `${currentHostUrl}/uploads/${pathStr}`;
}

function getFullUrl(req, dbPath) {
    if (!dbPath) return "";
    
    if (dbPath.startsWith('[') && dbPath.endsWith(']')) {
        try {
            const urls = JSON.parse(dbPath);
            const absoluteUrls = urls.map(url => getSingleFullUrl(req, url));
            return JSON.stringify(absoluteUrls);
        } catch (e) {
            // Ignore error and return default path
        }
    }
    
    return getSingleFullUrl(req, dbPath);
}

// Maps PostgreSQL lowercase keys to PascalCase/camelCase for the Flutter app
function mapPropertyRow(req, row) {
    const imageUrl = getSingleFullUrl(req, row.imageurl || row.ImageUrl || "");
    const images = getFullUrl(req, row.images || row.Images || "");
    
    return {
        Id: row.id || row.Id,
        TitleAr: row.titlear || row.TitleAr,
        TitleEn: row.titleen || row.TitleEn,
        Price: parseFloat(row.price || row.Price || 0),
        AreaAr: row.areaar || row.AreaAr,
        AreaEn: row.areaen || row.AreaEn,
        TypeAr: row.typear || row.TypeAr,
        TypeEn: row.typeen || row.TypeEn,
        ProjectAr: row.projectar || row.ProjectAr,
        ProjectEn: row.projecten || row.ProjectEn,
        Rooms: row.rooms || row.Rooms,
        DescAr: row.descar || row.DescAr || row.descriptionar || row.DescriptionAr || "",
        DescEn: row.descen || row.DescEn || row.descriptionen || row.DescriptionEn || "",
        DescriptionAr: row.descar || row.DescAr || row.descriptionar || row.DescriptionAr || "",
        DescriptionEn: row.descen || row.DescEn || row.descriptionen || row.DescriptionEn || "",
        ImageUrl: imageUrl,
        Images: images,
        IsVisible: row.isvisible !== undefined ? (row.isvisible === 1 || row.isvisible === true ? 1 : 0) : (row.IsVisible === 1 || row.IsVisible === true ? 1 : 0),
        IsSpecialOffer: row.isspecialoffer !== undefined ? (row.isspecialoffer === 1 || row.isspecialoffer === true ? 1 : 0) : (row.IsSpecialOffer === 1 || row.IsSpecialOffer === true ? 1 : 0)
    };
}

// --- 5. Routes ---

// A. Add new property
app.post('/add-property', upload.array('propertyImages'), async (req, res) => {
    try {
        const p = req.body;
        const files = req.files;

        if (parseInt(p.isSpecialOffer) === 1) {
            await pool.query("UPDATE Properties SET IsSpecialOffer = 0");
        }

        const imageUrls = files.map(file => `uploads/${file.filename}`);
        let mainImage = imageUrls.length > 0 ? imageUrls[0] : "";
        
        const query = `
            INSERT INTO Properties (
                TitleAr, TitleEn, Price, AreaAr, AreaEn, TypeAr, TypeEn, 
                ProjectAr, ProjectEn, Rooms, DescAr, DescEn, ImageUrl, Images, 
                IsVisible, IsSpecialOffer
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `;
        const values = [
            p.titleAr, p.titleEn, parseFloat(p.price), p.areaAr, p.areaEn, 
            p.typeAr, p.typeEn, p.projectAr, p.projectEn, p.rooms, 
            p.descAr, p.descEn, mainImage, JSON.stringify(imageUrls), 
            parseInt(p.isVisible), parseInt(p.isSpecialOffer)
        ];

        await pool.query(query, values);
        res.status(200).send({ message: 'Success' });
    } catch (err) { 
        console.error(err);
        res.status(500).send(err.message); 
    }
});

// B. Update property
app.post('/update-property/:id', upload.array('propertyImages'), async (req, res) => {
    try {
        const { id } = req.params;
        const p = req.body;
        const files = req.files;
        
        if (parseInt(p.isSpecialOffer) === 1) {
            await pool.query("UPDATE Properties SET IsSpecialOffer = 0");
        }

        let query = `
            UPDATE Properties SET 
                TitleAr=$1, TitleEn=$2, Price=$3, AreaAr=$4, AreaEn=$5, 
                TypeAr=$6, TypeEn=$7, ProjectAr=$8, ProjectEn=$9, Rooms=$10, 
                DescAr=$11, DescEn=$12, IsVisible=$13, IsSpecialOffer=$14
        `;
        const values = [
            p.titleAr, p.titleEn, parseFloat(p.price), p.areaAr, p.areaEn, 
            p.typeAr, p.typeEn, p.projectAr, p.projectEn, p.rooms, 
            p.descAr, p.descEn, parseInt(p.isVisible), parseInt(p.isSpecialOffer)
        ];

        let paramIndex = 15;
        if (files && files.length > 0) {
            const imageUrls = files.map(file => `uploads/${file.filename}`);
            query += `, ImageUrl=$${paramIndex}, Images=$${paramIndex + 1}`;
            values.push(imageUrls[0]);
            values.push(JSON.stringify(imageUrls));
            paramIndex += 2;
        }

        query += ` WHERE Id=$${paramIndex}`;
        values.push(parseInt(id));

        await pool.query(query, values);
        res.status(200).send({ message: 'Updated Successfully' });
    } catch (err) { 
        console.error(err);
        res.status(500).send(err.message); 
    }
});

// C. Delete property and log reason
app.post('/delete-property/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        // 1. Get property details before delete
        const propResult = await pool.query("SELECT TitleAr, TitleEn FROM Properties WHERE Id = $1", [parseInt(id)]);
            
        if (propResult.rows.length > 0) {
            const prop = propResult.rows[0];
            
            // 2. Log deletion
            await pool.query(
                `INSERT INTO DeletedPropertiesLog (PropertyId, TitleAr, TitleEn, Reason, DeletedAt) 
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
                [parseInt(id), prop.titlear || prop.TitleAr, prop.titleen || prop.TitleEn, reason || "بدون سبب"]
            );
        }
        
        // 3. Physical delete
        await pool.query('DELETE FROM Properties WHERE Id = $1', [parseInt(id)]);
            
        res.status(200).send({ message: 'Deleted and logged successfully' });
    } catch (err) { 
        console.error(err);
        res.status(500).send(err.message); 
    }
});

// D. Get all properties (with dynamic image URLs)
app.get('/get-properties', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM Properties ORDER BY Id DESC");
        const properties = result.rows.map(row => mapPropertyRow(req, row));
        res.status(200).json(properties);
    } catch (err) { 
        res.status(500).send(err.message); 
    }
});

// E. Add Lead
app.post('/add-lead', async (req, res) => {
    try {
        const { name, phone, method } = req.body;
        if (!name || !phone) return res.status(400).send({ message: 'Data Missing' });

        await pool.query(
            "INSERT INTO Leads (Name, Phone, Method, CreatedAt) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)",
            [name, phone, method]
        );
        res.status(200).send({ message: 'Lead Saved' });
    } catch (err) { 
        res.status(500).send(err.message); 
    }
});

// F. Get Splash Settings
app.get('/get-settings', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM AppSettings WHERE Id = 1 LIMIT 1");
        if (result.rows.length > 0) {
            const settings = result.rows[0];
            res.status(200).json({
                Id: settings.id || settings.Id,
                SplashBgUrl: getSingleFullUrl(req, settings.splashbgurl || settings.SplashBgUrl || ""),
                UseCustomSplash: settings.usecustomsplash !== undefined ? settings.usecustomsplash : settings.UseCustomSplash
            });
        } else {
            res.status(200).json({ Id: 1, SplashBgUrl: null, UseCustomSplash: 0 });
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// G. Update Splash Settings
app.post('/update-settings', async (req, res) => {
    try {
        const { splashBgUrl, useCustomSplash } = req.body;
        
        let relativeUrl = splashBgUrl;
        if (splashBgUrl && (splashBgUrl.startsWith('http://') || splashBgUrl.startsWith('https://'))) {
            try {
                const urlObj = new URL(splashBgUrl);
                relativeUrl = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
            } catch (e) {}
        }

        await pool.query(
            "UPDATE AppSettings SET SplashBgUrl = $1, UseCustomSplash = $2 WHERE Id = 1",
            [relativeUrl, parseInt(useCustomSplash)]
        );
        res.status(200).send({ message: 'Settings Updated Successfully' });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// H. Upload new splash logo background image
app.post('/upload-splash-bg', upload.single('splashImage'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send({ message: 'No file uploaded' });
        }
        const relativeUrl = `uploads/${req.file.filename}`;
        
        await pool.query(
            "UPDATE AppSettings SET SplashBgUrl = $1, UseCustomSplash = 1 WHERE Id = 1",
            [relativeUrl]
        );

        const fullUrl = getSingleFullUrl(req, relativeUrl);
        res.status(200).json({ splashBgUrl: fullUrl, useCustomSplash: 1 });
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

// Start the server on a flexible port
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`🚀 Server is running live on port ${port}`);
    console.log(`🔗 Local Address: http://localhost:${port}`);
});