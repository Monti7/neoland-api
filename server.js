const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer'); 
const path = require('path');
const fs = require('fs');

const app = express();

// --- 1. إعدادات الـ Middleware ---

// السماح بالاتصال من أي مكان (مهم جداً للـ Publish والـ Web)
app.use(cors()); 

// تخطي صفحة تحذير Ngrok للأبد (عشان الصور تظهر في الأبلكيشن فوري)
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

app.use(express.json()); 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// جعل مجلد الصور متاحاً أونلاين مع Headers الأمان
app.use('/uploads', express.static('uploads', {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
}));

// التأكد من وجود مجلد الرفع
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// --- 2. إعداد multer لتخزين الصور ---
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- 3. إعدادات قاعدة البيانات SQL Server ---
const config = {
    user: 'sa', 
    password: '123', 
    server: 'DESKTOP-QONGK0O',
    database: 'NeoLandDB',
    options: {
        instanceName: 'SQL2019',
        encrypt: false, 
        trustServerCertificate: true
    }
};

// مدير الاتصال بقاعدة البيانات (Connection Pool Manager)
let pool = null;

async function getDatabaseConnection() {
    if (pool && pool.connected) {
        return pool;
    }
    
    try {
        console.log("🔄 Connecting to SQL Server...");
        pool = await sql.connect(config);
        console.log("✅ Connected to SQL Server (NeoLandDB) Successfully!");
        return pool;
    } catch (err) {
        console.error("❌ SQL Server Connection Error: ", err.message);
        
        // محاولة الاتصال بـ localhost كـ fallback في حال فشل اسم الكمبيوتر
        if (config.server !== 'localhost' && config.server !== '127.0.0.1') {
            console.log("🔄 Trying fallback server 'localhost'...");
            try {
                const fallbackConfig = { ...config, server: 'localhost' };
                pool = await sql.connect(fallbackConfig);
                console.log("✅ Connected to SQL Server on localhost Successfully!");
                return pool;
            } catch (fallbackErr) {
                console.error("❌ SQL Server Fallback to localhost also failed: ", fallbackErr.message);
            }
        }
        throw err;
    }
}

// التحقق من وجود جدول إعدادات التطبيق وتكوينه عند التشغيل
getDatabaseConnection().then(async (activePool) => {
    try {
        // التحقق من جدول AppSettings
        await activePool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AppSettings' AND xtype='U')
            BEGIN
                CREATE TABLE AppSettings (
                    Id INT PRIMARY KEY,
                    SplashBgUrl NVARCHAR(MAX) NULL,
                    UseCustomSplash INT DEFAULT 0
                );
                INSERT INTO AppSettings (Id, SplashBgUrl, UseCustomSplash) VALUES (1, NULL, 0);
                PRINT '✅ Created AppSettings table and inserted default row.';
            END
            ELSE
            BEGIN
                PRINT '✅ AppSettings table already exists.';
            END
        `);
        
        // التحقق من جدول DeletedPropertiesLog
        await activePool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='DeletedPropertiesLog' AND xtype='U')
            BEGIN
                CREATE TABLE DeletedPropertiesLog (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PropertyId INT NULL,
                    TitleAr NVARCHAR(MAX) NULL,
                    TitleEn NVARCHAR(MAX) NULL,
                    Reason NVARCHAR(MAX) NULL,
                    DeletedAt DATETIME DEFAULT GETDATE()
                );
                PRINT '✅ Created DeletedPropertiesLog table.';
            END
            ELSE
            BEGIN
                PRINT '✅ DeletedPropertiesLog table already exists.';
            END
        `);
    } catch (e) {
        console.error("❌ Error checking/creating tables: ", e.message);
    }
}).catch(err => {
    console.error("❌ Initial database connection setup failed: ", err.message);
});

// دالة لتحويل الروابط إلى روابط كاملة تحتوي على الـ Host النشط حالياً
function getSingleFullUrl(req, pathStr) {
    if (!pathStr) return "";
    
    // استخراج اسم البروتوكول والـ host من الطلب الحالي
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const currentHostUrl = `${protocol}://${host}`;

    // إذا كان الرابط كاملاً بالفعل، نقوم بتحديث الـ host فقط ليتطابق مع الـ ngrok الحالي
    if (pathStr.startsWith('http://') || pathStr.startsWith('https://')) {
        try {
            const urlObj = new URL(pathStr);
            return `${currentHostUrl}${urlObj.pathname}`;
        } catch (e) {
            return pathStr;
        }
    }
    
    // إذا كان المسار يبدأ بـ uploads
    if (pathStr.startsWith('uploads/')) {
        return `${currentHostUrl}/${pathStr}`;
    }
    if (pathStr.startsWith('/uploads/')) {
        return `${currentHostUrl}${pathStr}`;
    }
    
    // إذا كان اسم ملف فقط
    return `${currentHostUrl}/uploads/${pathStr}`;
}

function getFullUrl(req, dbPath) {
    if (!dbPath) return "";
    
    // إذا كان مخزناً كـ مصفوفة JSON للصور المتعددة
    if (dbPath.startsWith('[') && dbPath.endsWith(']')) {
        try {
            const urls = JSON.parse(dbPath);
            const absoluteUrls = urls.map(url => getSingleFullUrl(req, url));
            return JSON.stringify(absoluteUrls);
        } catch (e) {
            // تجاهل الخطأ والرجوع للوضع الافتراضي
        }
    }
    
    return getSingleFullUrl(req, dbPath);
}

// --- 4. المسارات (Routes) ---

// أ. إضافة عقار جديد (تخزين مسارات نسبية لتجنب تلف الروابط عند تغير ngrok)
app.post('/add-property', upload.array('propertyImages'), async (req, res) => {
    try {
        const p = req.body;
        const files = req.files;
        let pool = await getDatabaseConnection();

        if (parseInt(p.isSpecialOffer) === 1) {
            await pool.request().query("UPDATE Properties SET IsSpecialOffer = 0");
        }

        // حفظ كمسارات نسبية مثل uploads/filename.jpg
        const imageUrls = files.map(file => `uploads/${file.filename}`);
        let mainImage = imageUrls.length > 0 ? imageUrls[0] : "";
        
        await pool.request()
            .input('tAr', sql.NVarChar, p.titleAr).input('tEn', sql.NVarChar, p.titleEn)
            .input('price', sql.Decimal(18, 2), parseFloat(p.price))
            .input('aAr', sql.NVarChar, p.areaAr).input('aEn', sql.NVarChar, p.areaEn)
            .input('tpAr', sql.NVarChar, p.typeAr).input('tpEn', sql.NVarChar, p.typeEn)
            .input('pAr', sql.NVarChar, p.projectAr).input('pEn', sql.NVarChar, p.projectEn)
            .input('rooms', sql.NVarChar, p.rooms)
            .input('dAr', sql.NVarChar, p.descAr).input('dEn', sql.NVarChar, p.descEn)
            .input('img', sql.NVarChar, mainImage)
            .input('allImgs', sql.NVarChar, JSON.stringify(imageUrls))
            .input('visible', sql.Int, parseInt(p.isVisible))
            .input('special', sql.Int, parseInt(p.isSpecialOffer))
            .query(`INSERT INTO Properties (TitleAr, TitleEn, Price, AreaAr, AreaEn, TypeAr, TypeEn, ProjectAr, ProjectEn, Rooms, DescAr, DescEn, ImageUrl, Images, IsVisible, IsSpecialOffer) 
                    VALUES (@tAr, @tEn, @price, @aAr, @aEn, @tpAr, @tpEn, @pAr, @pEn, @rooms, @dAr, @dEn, @img, @allImgs, @visible, @special)`);
        
        res.status(200).send({ message: 'Success' });
    } catch (err) { 
        console.error(err);
        res.status(500).send(err.message); 
    }
});

// ب. تعديل عقار (Update)
app.post('/update-property/:id', upload.array('propertyImages'), async (req, res) => {
    try {
        const { id } = req.params;
        const p = req.body;
        const files = req.files;
        let pool = await getDatabaseConnection();
        
        if (parseInt(p.isSpecialOffer) === 1) {
            await pool.request().query("UPDATE Properties SET IsSpecialOffer = 0");
        }

        let updateQuery = `UPDATE Properties SET TitleAr=@tAr, TitleEn=@tEn, Price=@price, AreaAr=@aAr, AreaEn=@aEn, 
                           TypeAr=@tpAr, TypeEn=@tpEn, ProjectAr=@pAr, ProjectEn=@pEn, Rooms=@rooms, 
                           DescAr=@dAr, DescEn=@dEn, IsVisible=@visible, IsSpecialOffer=@special`;

        const request = pool.request()
            .input('id', sql.Int, id)
            .input('tAr', sql.NVarChar, p.titleAr).input('tEn', sql.NVarChar, p.titleEn)
            .input('price', sql.Decimal(18, 2), parseFloat(p.price))
            .input('aAr', sql.NVarChar, p.areaAr).input('aEn', sql.NVarChar, p.areaEn)
            .input('tpAr', sql.NVarChar, p.typeAr).input('tpEn', sql.NVarChar, p.typeEn)
            .input('pAr', sql.NVarChar, p.projectAr).input('pEn', sql.NVarChar, p.projectEn)
            .input('rooms', sql.NVarChar, p.rooms)
            .input('dAr', sql.NVarChar, p.descAr).input('dEn', sql.NVarChar, p.descEn)
            .input('visible', sql.Int, parseInt(p.isVisible))
            .input('special', sql.Int, parseInt(p.isSpecialOffer));

        if (files && files.length > 0) {
            const imageUrls = files.map(file => `uploads/${file.filename}`);
            request.input('img', sql.NVarChar, imageUrls[0]);
            request.input('allImgs', sql.NVarChar, JSON.stringify(imageUrls));
            updateQuery += `, ImageUrl=@img, Images=@allImgs`;
        }

        updateQuery += ` WHERE Id=@id`;
        await request.query(updateQuery);
        res.status(200).send({ message: 'Updated Successfully' });
    } catch (err) { 
        console.error(err);
        res.status(500).send(err.message); 
    }
});

// ج. حذف عقار وحفظ سبب الحذف
app.post('/delete-property/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        let pool = await getDatabaseConnection();
        
        // 1. جلب بيانات العقار قبل حذفه
        let propResult = await pool.request()
            .input('id', sql.Int, id)
            .query("SELECT TitleAr, TitleEn FROM Properties WHERE Id = @id");
            
        if (propResult.recordset.length > 0) {
            const prop = propResult.recordset[0];
            
            // 2. إدخال سجل في جدول سجل المحذوفات
            await pool.request()
                .input('propertyId', sql.Int, id)
                .input('tAr', sql.NVarChar, prop.TitleAr)
                .input('tEn', sql.NVarChar, prop.TitleEn)
                .input('reason', sql.NVarChar, reason || "بدون سبب")
                .query(`INSERT INTO DeletedPropertiesLog (PropertyId, TitleAr, TitleEn, Reason, DeletedAt) 
                        VALUES (@propertyId, @tAr, @tEn, @reason, GETDATE())`);
        }
        
        // 3. الحذف الفعلي من قاعدة البيانات
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM Properties WHERE Id = @id');
            
        res.status(200).send({ message: 'Deleted and logged successfully' });
    } catch (err) { 
        console.error(err);
        res.status(500).send(err.message); 
    }
});

// د. جلب جميع العقارات (مع تعديل الروابط ديناميكياً)
app.get('/get-properties', async (req, res) => {
    try {
        let pool = await getDatabaseConnection();
        let result = await pool.request().query("SELECT * FROM Properties ORDER BY id DESC");
        
        // تحويل روابط الصور ديناميكياً لتطابق host الطلب الحالي
        const properties = result.recordset.map(p => {
            return {
                ...p,
                ImageUrl: getSingleFullUrl(req, p.ImageUrl),
                Images: getFullUrl(req, p.Images)
            };
        });
        
        res.status(200).json(properties);
    } catch (err) { res.status(500).send(err.message); }
});

// هـ. إضافة Leads
app.post('/add-lead', async (req, res) => {
    try {
        const { name, phone, method } = req.body;
        if (!name || !phone) return res.status(400).send({ message: 'Data Missing' });

        let pool = await getDatabaseConnection();
        await pool.request()
            .input('name', sql.NVarChar, name)
            .input('phone', sql.NVarChar, phone)
            .input('method', sql.NVarChar, method)
            .query(`INSERT INTO Leads (Name, Phone, Method, CreatedAt) VALUES (@name, @phone, @method, GETDATE())`);
        res.status(200).send({ message: 'Lead Saved' });
    } catch (err) { res.status(500).send(err.message); }
});

// و. جلب إعدادات شاشة الترحيب (Splash Settings)
app.get('/get-settings', async (req, res) => {
    try {
        let pool = await getDatabaseConnection();
        let result = await pool.request().query("SELECT TOP 1 * FROM AppSettings WHERE Id = 1");
        if (result.recordset.length > 0) {
            const settings = result.recordset[0];
            res.status(200).json({
                ...settings,
                SplashBgUrl: getSingleFullUrl(req, settings.SplashBgUrl)
            });
        } else {
            res.status(200).json({ Id: 1, SplashBgUrl: null, UseCustomSplash: 0 });
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ز. تحديث إعدادات شاشة الترحيب
app.post('/update-settings', async (req, res) => {
    try {
        const { splashBgUrl, useCustomSplash } = req.body;
        
        // استخلاص المسار النسبي فقط لحفظه في الداتابيز لتجنب التلف عند تغير ngrok
        let relativeUrl = splashBgUrl;
        if (splashBgUrl && (splashBgUrl.startsWith('http://') || splashBgUrl.startsWith('https://'))) {
            try {
                const urlObj = new URL(splashBgUrl);
                // حذف slash البداية
                relativeUrl = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
            } catch (e) {}
        }

        let pool = await getDatabaseConnection();
        await pool.request()
            .input('url', sql.NVarChar, relativeUrl)
            .input('useCustom', sql.Int, parseInt(useCustomSplash))
            .query("UPDATE AppSettings SET SplashBgUrl = @url, UseCustomSplash = @useCustom WHERE Id = 1");
        res.status(200).send({ message: 'Settings Updated Successfully' });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ح. رفع صورة خلفية جديدة للـ Splash وتفعيلها تلقائياً
app.post('/upload-splash-bg', upload.single('splashImage'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send({ message: 'No file uploaded' });
        }
        const relativeUrl = `uploads/${req.file.filename}`;
        
        let pool = await getDatabaseConnection();
        await pool.request()
            .input('url', sql.NVarChar, relativeUrl)
            .query("UPDATE AppSettings SET SplashBgUrl = @url, UseCustomSplash = 1 WHERE Id = 1");

        const fullUrl = getSingleFullUrl(req, relativeUrl);
        res.status(200).json({ splashBgUrl: fullUrl, useCustomSplash: 1 });
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

// تشغيل السيرفر
const port = 3000;
app.listen(port, () => {
    console.log(`🚀 Server is running live on port ${port}`);
    console.log(`🔗 Local Address: http://localhost:${port}`);
});