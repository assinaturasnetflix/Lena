// server.js

// -----------------------------------------------------------------------------
// 1. IMPORTS E CONFIGURAÇÃO INICIAL
// -----------------------------------------------------------------------------
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI; // Ex: mongodb://localhost:27017/investment_site ou sua string do Atlas/Render
const JWT_SECRET = process.env.JWT_SECRET || 'your-very-strong-jwt-secret-key';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://gold-mt.netlify.app'; // Ou a URL do seu frontend no Render

// -----------------------------------------------------------------------------
// 2. MIDDLEWARE
// -----------------------------------------------------------------------------
app.use(cors({
    origin: '*' // Permite requisições de qualquer origem. Para produção, restrinja ao seu frontend.
    // origin: [FRONTEND_URL, 'http://localhost:xxxx'] // Se tiver um admin em outra porta/url
}));
app.use(express.json()); // Para parsear JSON no corpo das requisições
app.use(express.urlencoded({ extended: true })); // Para parsear dados de formulário URL-encoded

// -----------------------------------------------------------------------------
// 3. CONEXÃO COM O MONGODB
// -----------------------------------------------------------------------------
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    // useCreateIndex: true, // Não mais necessário no Mongoose 6+
    // useFindAndModify: false // Não mais necessário no Mongoose 6+
})
.then(() => console.log('MongoDB conectado com sucesso!'))
.catch(err => console.error('Erro ao conectar ao MongoDB:', err));

// -----------------------------------------------------------------------------
// 4. MODELOS (SCHEMAS) DO MONGODB
// -----------------------------------------------------------------------------

// 4.1. Schema do Usuário (User)
const claimSchema = new mongoose.Schema({
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
    planName: String,
    claimNumber: Number, // 1 a 5
    amount: Number, // Valor do claim em MT
    currency: String, // Moeda em que o valor foi creditado/representado (ex: MT, BTC, ETH)
    claimedAt: { type: Date, default: Date.now }
});

const activeInvestmentSchema = new mongoose.Schema({
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    planName: { type: String, required: true },
    investedAmount: { type: Number, required: true },
    dailyProfitRate: { type: Number, required: true }, // Percentual
    dailyProfitAmount: { type: Number, required: true }, // Em MT
    claimValue: { type: Number, required: true }, // Valor de cada um dos 5 claims, em MT
    claimsMadeToday: { type: Number, default: 0 },
    lastClaimDate: { type: Date },
    activatedAt: { type: Date, default: Date.now },
    // currencyDistribution: [{ currency: String, percentage: Number }] // Se cada claim tiver uma moeda pré-definida
});


const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    securityQuestion: { type: String, required: true },
    securityAnswer: { type: String, required: true }, // Será hasheada
    referralCode: { type: String, unique: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    balance: { // Saldo principal em MT
        MT: { type: Number, default: 0 }
        // Poderíamos adicionar outros saldos de cripto aqui se os claims fossem diretamente em cripto
        // BTC: { type: Number, default: 0 },
        // ETH: { type: Number, default: 0 },
        // USDT: { type: Number, default: 0 }
    },
    bonusBalance: { type: Number, default: 0 }, // Saldo de bônus (cadastro, referência)
    referralEarnings: { type: Number, default: 0 }, // Ganhos de referência já contabilizados
    activeInvestments: [activeInvestmentSchema],
    claimHistory: [claimSchema],
    isBlocked: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false },
    firstDepositMade: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date }
});

// Método para gerar código de referência único
userSchema.pre('save', async function(next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    if (this.isModified('securityAnswer')) {
        this.securityAnswer = await bcrypt.hash(this.securityAnswer, 10);
    }
    if (!this.referralCode) {
        this.referralCode = Math.random().toString(36).substring(2, 10).toUpperCase();
    }
    next();
});

const User = mongoose.model('User', userSchema);

// 4.2. Schema dos Planos de Investimento (Plan)
const planSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }, // Ex: "Plano de 500 MT"
    investmentAmount: { type: Number, required: true, unique: true }, // Valor do plano, ex: 500
    dailyProfitRate: { type: Number, required: true }, // Em percentual, ex: 6.21
    dailyProfitAmount: { type: Number, required: true }, // Lucro por dia em MT, ex: 31.05
    claimValue: { type: Number, required: true }, // Valor de cada claim em MT, ex: 6.21
    claimsPerDay: { type: Number, default: 5 },
    // lifetime: { type: Boolean, default: true }, // Implícito pela estrutura de não ter data de fim
    // associatedCurrenciesForClaim: [{ type: String }], // Ex: ['BTC', 'ETH', 'USDT', 'MT'] moedas que o user pode escolher ao fazer claim
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 } // Para ordenar a exibição dos planos
});

const Plan = mongoose.model('Plan', planSchema);

// 4.3. Schema dos Depósitos (Deposit)
const depositSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    method: { type: String, required: true }, // Mpesa, Emola, BTC, ETH, USDT
    transactionIdOrConfirmationMessage: { type: String, required: true }, // Número da transação ou mensagem colada
    paymentDetailsUsed: { type: String }, // O número/carteira para onde o depósito foi feito
    status: { type: String, enum: ['Pendente', 'Confirmado', 'Rejeitado'], default: 'Pendente' },
    requestedAt: { type: Date, default: Date.now },
    processedAt: { type: Date }
});

const Deposit = mongoose.model('Deposit', depositSchema);

// 4.4. Schema de Saques (Withdrawal)
const withdrawalSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true }, // Valor em MT a ser sacado
    withdrawalMethod: { type: String, required: true }, // Mpesa, Emola, BTC, ETH, USDT
    recipientInfo: { type: String, required: true }, // Número Mpesa/Emola, Endereço da carteira cripto
    feeApplied: { type: Number, default: 0 }, // Taxa de manuseio em MT
    netAmount: { type: Number, required: true }, // Valor líquido após taxa
    status: { type: String, enum: ['Pendente', 'Processado', 'Rejeitado'], default: 'Pendente' },
    requestedAt: { type: Date, default: Date.now },
    processedAt: { type: Date },
    adminNotes: { type: String }
});

const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);


// 4.5. Schema de Notificações (Notification) - Para admin enviar aos usuários
const notificationSchema = new mongoose.Schema({
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, enum: ['info', 'warning', 'danger', 'success', 'modal', 'banner'], default: 'info' }, // modal, banner, alerta
    targetAudience: { type: String, enum: ['all', 'specificUser', 'group'], default: 'all' }, // Para quem é
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // Se for para usuário específico
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date }
});

const Notification = mongoose.model('Notification', notificationSchema);

// 4.6. Schema de Configurações do Admin (AdminConfig)
// Para textos de contato, métodos de pagamento ativos, etc.
const paymentMethodSchema = new mongoose.Schema({
    name: { type: String, required: true }, // Mpesa, Emola, BTC, ETH, USDT
    details: { type: String, required: true }, // Número da conta, endereço da carteira
    instructions: { type: String }, // Instruções adicionais
    isActive: { type: Boolean, default: true },
    type: { type: String, enum: ['fiat', 'crypto'], required: true}
});

const adminSettingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true }, // Ex: 'contactTextLogin', 'mpesaDetails', 'btcWallet'
    value: mongoose.Schema.Types.Mixed, // Pode ser string, objeto, array
    description: String
});
// Exemplo de como usar AdminSetting:
// { key: 'paymentMethods', value: [ { name: 'Mpesa', details: '84xxxxxxx', instructions: 'Envie para este número e cole a msg.' } ]}
// { key: 'contactInfoLogin', value: 'Para ajuda, contate admin@example.com' }

const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

// 4.7. Schema do Histórico de Referências (ReferralHistory)
const referralHistorySchema = new mongoose.Schema({
    referrerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Quem indicou
    referredId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true }, // Quem foi indicado
    status: { type: String, enum: ['Pendente', 'Confirmado'], default: 'Pendente' }, // Confirmado quando o indicado faz o primeiro depósito
    bonusAmount: { type: Number, default: 65 }, // MT
    earnedAt: { type: Date }
});

const ReferralHistory = mongoose.model('ReferralHistory', referralHistorySchema);


// (FakeData pode ser gerado dinamicamente nas rotas, não precisa de um schema fixo, a menos que queira persistir)

// -----------------------------------------------------------------------------
// 5. FUNÇÕES UTILITÁRIAS (Básicas por enquanto)
// -----------------------------------------------------------------------------

// Gerar Token JWT
const generateToken = (userId, isAdmin = false) => {
    return jwt.sign({ id: userId, isAdmin }, JWT_SECRET, { expiresIn: '24h' }); // Token expira em 24 horas
};

// Middleware de Autenticação JWT
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ message: 'Acesso não autorizado: Token não fornecido.' });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            console.error("Erro na verificação do JWT:", err.message);
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Token expirado. Por favor, faça login novamente.' });
            }
            return res.status(403).json({ message: 'Token inválido.' });
        }
        req.user = decoded; // Adiciona o payload decodificado (id, isAdmin) ao objeto req
        next();
    });
};

// Middleware de Autorização de Admin
const authorizeAdmin = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ message: 'Acesso negado: Recurso exclusivo para administradores.' });
    }
    next();
};

// Função para buscar configurações do admin (cache simples para evitar múltiplas buscas ao DB)
let siteSettingsCache = null;
async function getSiteSettings() {
    if (siteSettingsCache) {
        // Poderia adicionar uma lógica de expiração de cache aqui
        // return siteSettingsCache;
    }
    try {
        const settings = await AdminSetting.find({});
        const formattedSettings = {};
        settings.forEach(setting => {
            formattedSettings[setting.key] = setting.value;
        });
        siteSettingsCache = formattedSettings;
        return formattedSettings;
    } catch (error) {
        console.error("Erro ao buscar configurações do site:", error);
        return {}; // Retorna objeto vazio em caso de erro
    }
}
// Inicializa o cache ao iniciar
getSiteSettings();


// -----------------------------------------------------------------------------
// 6. CRON JOBS (Exemplo: Reset de Claims Diários)
// -----------------------------------------------------------------------------

// Roda todos os dias à meia-noite (00:00)
cron.schedule('0 0 * * *', async () => {
    console.log('Executando cron job: Resetando claims diários...');
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Início do dia atual

        // Encontra usuários com investimentos ativos
        const usersWithActiveInvestments = await User.find({
            'activeInvestments.0': { $exists: true } // Pelo menos um investimento ativo
        });

        for (const user of usersWithActiveInvestments) {
            let userModified = false;
            for (const investment of user.activeInvestments) {
                // Verifica se o último claim não foi hoje e se há claims feitos
                if (investment.claimsMadeToday > 0) {
                    // Se lastClaimDate não está definido ou é anterior a hoje, reseta
                    if (!investment.lastClaimDate || investment.lastClaimDate < today) {
                        investment.claimsMadeToday = 0;
                        userModified = true;
                    }
                }
            }
            if (userModified) {
                await user.save();
                console.log(`Claims resetados para o usuário ${user.email}`);
            }
        }
        console.log('Cron job: Reset de claims diários concluído.');
    } catch (error) {
        console.error('Erro no cron job de reset de claims:', error);
    }
}, {
    scheduled: true,
    timezone: "Africa/Maputo" // Ajuste para o fuso horário desejado
});
// server.js
// ... (imports, config, middleware, etc.) ...

// Logo após a seção de CONEXÃO COM O MONGODB e antes dos MODELOS
// Ou no final, antes de app.listen()

// -----------------------------------------------------------------------------
// FUNÇÃO PARA CRIAR ADMIN INICIAL (SE NÃO EXISTIR)
// -----------------------------------------------------------------------------
async function createInitialAdmin() {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;

    if (!adminEmail || !adminPassword) {
        console.warn("Credenciais de admin inicial não definidas no .env. Nenhum admin inicial será criado.");
        return;
    }

    try {
        const existingAdmin = await User.findOne({ email: adminEmail.toLowerCase() });

        if (existingAdmin) {
            console.log(`Usuário admin (${adminEmail}) já existe.`);
            // Opcional: verificar se isAdmin é true e atualizar se não for
            if (!existingAdmin.isAdmin) {
                existingAdmin.isAdmin = true;
                await existingAdmin.save();
                console.log(`Usuário ${adminEmail} atualizado para admin.`);
            }
            return;
        }

        // Se não existe, criar
        // Detalhes adicionais para o admin (nome, pergunta/resposta de segurança)
        // É melhor que o admin preencha isso após o primeiro login,
        // mas para criar o usuário precisamos de alguns campos obrigatórios.
        // Vamos usar placeholders ou valores padrão simples.
        const name = "Administrador Principal";
        const securityQuestion = "Qual é o código de segurança do sistema?"; // Placeholder
        const securityAnswer = "admin_recovery_code_123"; // Placeholder, será hasheada

        const newAdmin = new User({
            name,
            email: adminEmail.toLowerCase(),
            password: adminPassword, // Será hasheada pelo hook pre-save
            securityQuestion,
            securityAnswer, // Será hasheada pelo hook pre-save
            isAdmin: true,
            isBlocked: false,
            balance: { MT: 0 },
            bonusBalance: 0, // Admin não precisa de bônus inicial
            firstDepositMade: true // Para não ter restrições de admin
        });

        await newAdmin.save();
        console.log(`Usuário admin inicial (${adminEmail}) criado com sucesso.`);
        console.log("IMPORTANTE: O administrador deve alterar a senha padrão no primeiro login!");

    } catch (error) {
        console.error("Erro ao tentar criar usuário admin inicial:", error);
    }
}

// ... (Modelos do MongoDB) ...

// Modifique a seção de CONEXÃO COM O MONGODB para chamar createInitialAdmin
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log('MongoDB conectado com sucesso!');
    createInitialAdmin(); // << CHAME A FUNÇÃO AQUI
})
.catch(err => console.error('Erro ao conectar ao MongoDB:', err));


// ... (Resto do seu server.js: Funções Utilitárias, Cron Jobs, Rotas, app.listen) ...


// -----------------------------------------------------------------------------
// PLACEHOLDER PARA ROTAS (serão adicionadas nas próximas partes)
// -----------------------------------------------------------------------------

app.get('/api', (req, res) => {
    res.json({ message: 'Bem-vindo à API da Plataforma de Investimentos GoldMT!' });
});

// (Rotas de Autenticação, Usuário, Admin virão aqui)


// -----------------------------------------------------------------------------
// INICIALIZAÇÃO DO SERVIDOR
// -----------------------------------------------------------------------------
// app.listen(PORT, '0.0.0.0', () => { // Escutar em 0.0.0.0 para acesso externo (ex: Docker, Render)
//     console.log(`Servidor rodando na porta ${PORT} e acessível externamente.`);
//     console.log(`Frontend URL configurada: ${FRONTEND_URL}`);
// });

// // Para desenvolvimento local, pode usar apenas:
// app.listen(PORT, () => {
//    console.log(`Servidor rodando na porta ${PORT}`);
//    console.log(`Frontend URL configurada: ${FRONTEND_URL}`);
// });
// server.js
// ... (todo o código da Parte 1: imports, config, middleware, conexão DB, modelos, utils, cron) ...

// -----------------------------------------------------------------------------
// 7. ROTAS DE AUTENTICAÇÃO
// -----------------------------------------------------------------------------
const authRouter = express.Router();

// 7.1. Rota de Cadastro (POST /api/auth/register)
authRouter.post('/register', async (req, res) => {
    const { name, email, password, securityQuestion, securityAnswer, referralCode: referredByCode } = req.body;

    // Validação básica
    if (!name || !email || !password || !securityQuestion || !securityAnswer) {
        return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser preenchidos.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ message: 'A senha deve ter pelo menos 6 caracteres.' });
    }

    try {
        // Verificar se o email já existe
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(409).json({ message: 'Este email já está cadastrado.' });
        }

        let referrer = null;
        if (referredByCode) {
            referrer = await User.findOne({ referralCode: referredByCode.toUpperCase() });
            if (!referrer) {
                return res.status(400).json({ message: 'Código de referência inválido.' });
            }
        }

        const newUser = new User({
            name,
            email: email.toLowerCase(),
            password, // Hashing é feito pelo hook pre-save
            securityQuestion,
            securityAnswer, // Hashing é feito pelo hook pre-save
            referredBy: referrer ? referrer._id : null,
            balance: { MT: 0 }, // Saldo inicial de MT é 0
            bonusBalance: 200, // Ganho inicial de 200 MT no saldo de bônus
        });

        await newUser.save();

        // Se foi referido, criar registro em ReferralHistory
        // O bônus de 65MT para o referrer será creditado quando o novo usuário fizer o primeiro depósito.
        if (referrer) {
            const referralEntry = new ReferralHistory({
                referrerId: referrer._id,
                referredId: newUser._id,
                status: 'Pendente', // Aguardando primeiro depósito do novo usuário
                bonusAmount: 65
            });
            await referralEntry.save();
        }

        const token = generateToken(newUser._id, newUser.isAdmin);

        res.status(201).json({
            message: 'Usuário cadastrado com sucesso! Bônus de 200 MT adicionado. Lembre-se de salvar sua pergunta e resposta de segurança.',
            token,
            user: {
                id: newUser._id,
                name: newUser.name,
                email: newUser.email,
                referralCode: newUser.referralCode,
                isAdmin: newUser.isAdmin
            }
        });

    } catch (error) {
        console.error('Erro no cadastro:', error);
        if (error.code === 11000 && error.keyPattern && error.keyPattern.referralCode) {
             // Tentativa de salvar usuário e houve colisão no referralCode gerado automaticamente
             // Isso é raro, mas pode acontecer. O frontend pode pedir para tentar novamente.
             // Ou podemos tentar gerar um novo código e salvar novamente aqui (mais complexo).
             // Por simplicidade, vamos retornar um erro genérico, mas o log acima ajuda a debugar.
            return res.status(500).json({ message: 'Erro ao gerar informações do usuário. Tente novamente.' });
        }
        res.status(500).json({ message: 'Erro interno do servidor ao tentar cadastrar.' });
    }
});

// 7.2. Rota de Login (POST /api/auth/login)
authRouter.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
    }

    try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(401).json({ message: 'Credenciais inválidas.' }); // Email não encontrado
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciais inválidas.' }); // Senha incorreta
        }

        if (user.isBlocked) {
            return res.status(403).json({ message: 'Sua conta está bloqueada. Entre em contato com o suporte.' });
        }

        user.lastLoginAt = new Date();
        await user.save();

        const token = generateToken(user._id, user.isAdmin);

        res.json({
            message: 'Login bem-sucedido!',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                isAdmin: user.isAdmin,
                referralCode: user.referralCode
            }
        });

    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ message: 'Erro interno do servidor ao tentar fazer login.' });
    }
});

// 7.3. Rota para Informação de Recuperação de Senha (POST /api/auth/request-password-recovery)
authRouter.post('/request-password-recovery', (req, res) => {
    // Não há lógica de envio de email aqui, apenas a informação conforme especificado.
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ message: "Email é obrigatório." });
    }
    // Apenas simula a verificação se o email existe para não vazar informações
    // Em um sistema real, você poderia querer logar essa tentativa.
    console.log(`Solicitação de recuperação de senha para: ${email}`);
    res.status(200).json({
        message: "Para recuperar sua senha, por favor, entre em contato com o administrador da plataforma e forneça seu email e a resposta para sua pergunta de segurança. O administrador irá guiá-lo no processo."
    });
});

app.use('/api/auth', authRouter);

// -----------------------------------------------------------------------------
// 8. ROTAS PÚBLICAS (Não requerem autenticação)
// -----------------------------------------------------------------------------
const publicRouter = express.Router();

// 8.1. Listar Planos de Investimento Ativos (GET /api/public/plans)
publicRouter.get('/plans', async (req, res) => {
    try {
        const plans = await Plan.find({ isActive: true }).sort({ order: 1, investmentAmount: 1 }); // Ordena por 'order' e depois por valor
        res.json(plans.map(plan => ({ // Não expor IDs internos desnecessariamente se não for preciso
            id: plan._id, // O frontend pode precisar do ID para selecionar o plano
            name: plan.name,
            investmentAmount: plan.investmentAmount,
            dailyProfitRate: plan.dailyProfitRate,
            dailyProfitAmount: plan.dailyProfitAmount,
            claimValue: plan.claimValue,
            claimsPerDay: plan.claimsPerDay,
            // lifetime: plan.lifetime // Já é implícito
        })));
    } catch (error) {
        console.error("Erro ao buscar planos:", error);
        res.status(500).json({ message: "Erro ao buscar planos de investimento." });
    }
});

// 8.2. Buscar Configurações Públicas do Site (GET /api/public/site-settings)
publicRouter.get('/site-settings', async (req, res) => {
    try {
        const allSettings = await getSiteSettings(); // Usa a função utilitária com cache

        // Filtrar apenas as configurações que são seguras para serem públicas
        const publicSettings = {
            contactTextLogin: allSettings.contactTextLogin,
            contactTextRegister: allSettings.contactTextRegister,
            contactTextPanel: allSettings.contactTextPanel,
            // Adicione outras chaves que devem ser públicas aqui
            // Ex: Informações sobre taxa de saque (se for uma string geral)
            withdrawalFeeInfo: allSettings.withdrawalFeeInfo || "Taxa de manuseio varia de 2% a 15% dependendo do valor e método.",
            maxWithdrawalAmount: allSettings.maxWithdrawalAmount || 50000,
            minWithdrawalAmount: allSettings.minWithdrawalAmount || 50,
            siteName: allSettings.siteName || "GoldMT Invest"
        };
        res.json(publicSettings);
    } catch (error) {
        console.error("Erro ao buscar configurações públicas do site:", error);
        res.status(500).json({ message: "Erro ao buscar configurações do site." });
    }
});

// 8.3. Rota para dados fictícios da página inicial (GET /api/public/fake-activity)
publicRouter.get('/fake-activity', (req, res) => {
    const activities = [
        { user: "Usuário A.", action: "depositou", amount: "750 MT", icon: "fa-arrow-down" },
        { user: "Investidor B.", action: "investiu no Plano Ouro", amount: "", icon: "fa-chart-line" },
        { user: "Cliente C.", action: "levantou", amount: "300 MT", icon: "fa-arrow-up" },
        { user: "Membro D.", action: "completou um claim de", amount: "79.70 MT", icon: "fa-check-circle" },
        { user: "Usuário E.", action: "registrou-se e ganhou", amount: "200 MT", icon: "fa-user-plus" },
        { user: "Investidor F.", action: "depositou", amount: "15000 MT", icon: "fa-arrow-down" },
        { user: "Cliente G.", action: "convidou um amigo", amount: "", icon: "fa-users" },
    ];
    // Embaralha e retorna algumas atividades
    const shuffled = activities.sort(() => 0.5 - Math.random());
    res.json(shuffled.slice(0, Math.floor(Math.random() * 3) + 3)); // Retorna entre 3 e 5 atividades
});


app.use('/api/public', publicRouter);


// -----------------------------------------------------------------------------
// PLACEHOLDER PARA ROTAS DO USUÁRIO AUTENTICADO (virão na próxima parte)
// -----------------------------------------------------------------------------
// const userRouter = express.Router();
// userRouter.use(authenticateToken); // Todas as rotas aqui são protegidas
// ...
// app.use('/api/user', userRouter);

// -----------------------------------------------------------------------------
// PLACEHOLDER PARA ROTAS DO ADMIN (virão na próxima parte)
// -----------------------------------------------------------------------------
// const adminRouter = express.Router();
// adminRouter.use(authenticateToken, authorizeAdmin); // Todas as rotas aqui são protegidas e para admin
// ...
// app.use('/api/admin', adminRouter);


// -----------------------------------------------------------------------------
// ROTA RAIZ (já definida na Parte 1)
// -----------------------------------------------------------------------------
// app.get('/api', (req, res) => { ... });

// -----------------------------------------------------------------------------
// INICIALIZAÇÃO DO SERVIDOR (já definida na Parte 1)
// -----------------------------------------------------------------------------
// app.listen(PORT, '0.0.0.0', () => { ... });
// Ou para desenvolvimento local:
app.listen(PORT, () => {
   console.log(`Servidor rodando na porta ${PORT}`);
   console.log(`Frontend URL configurada: ${FRONTEND_URL}`);
   console.log(`JWT Secret (apenas para debug, NÃO USE EM PRODUÇÃO): ${JWT_SECRET}`);
});
// server.js
// ... (todo o código da Parte 1 e Parte 2) ...

// -----------------------------------------------------------------------------
// 9. ROTAS DO USUÁRIO AUTENTICADO
// -----------------------------------------------------------------------------
const userRouter = express.Router();
userRouter.use(authenticateToken); // Todas as rotas aqui são protegidas

// 9.1. Obter Dados do Painel do Usuário (GET /api/user/dashboard)
userRouter.get('/dashboard', async (req, res) => {
    try {
        const user = await User.findById(req.user.id)
            .select('-password -securityAnswer -securityQuestion') // Não enviar dados sensíveis
            .populate('activeInvestments.planId', 'name') // Popula o nome do plano
            .populate('referredBy', 'name email'); // Apenas para info, se necessário

        if (!user) {
            return res.status(404).json({ message: "Usuário não encontrado." });
        }

        // Calcular saldo total (MT principal + Bônus + Ganhos de Referência não sacados)
        // O bônus e ganhos de referência só são "liberados" para saque após o primeiro depósito.
        // Mas para exibição no saldo total, podemos somá-los.
        const totalBalance = (user.balance.MT || 0) + (user.bonusBalance || 0) + (user.referralEarnings || 0);

        // Preparar dados dos investimentos ativos
        const activeInvestmentsDetails = user.activeInvestments.map(inv => ({
            id: inv._id, // ID do investimento ativo específico
            planName: inv.planName,
            investedAmount: inv.investedAmount,
            dailyProfitAmount: inv.dailyProfitAmount,
            claimValue: inv.claimValue,
            claimsMadeToday: inv.claimsMadeToday,
            claimsPerDay: (inv.planId && inv.planId.claimsPerDay) || 5, // Pegar do plano original ou default
            activatedAt: inv.activatedAt,
        }));

        // Histórico de claims (simplificado por enquanto, pode ser mais detalhado)
        const claimHistoryDetails = user.claimHistory
            .sort((a, b) => b.claimedAt - a.claimedAt) // Mais recentes primeiro
            .slice(0, 20) // Limitar a 20 por performance
            .map(claim => ({
                planName: claim.planName,
                amount: claim.amount,
                currency: claim.currency,
                claimedAt: claim.claimedAt,
                claimNumber: claim.claimNumber
            }));
        
        // Depósitos do usuário
        const deposits = await Deposit.find({ userId: req.user.id })
            .sort({ requestedAt: -1 })
            .limit(10)
            .select('amount method status requestedAt');

        // Informações de Referência
        const referralsMade = await ReferralHistory.find({ referrerId: req.user.id });
        const successfulReferrals = referralsMade.filter(r => r.status === 'Confirmado').length;
        // Ganhos de referência já estão em user.referralEarnings

        // Notificações do Admin (ativas e para 'all' ou 'specificUser' este usuário)
        const now = new Date();
        const userNotifications = await Notification.find({
            isActive: true,
            $or: [
                { targetAudience: 'all' },
                { targetAudience: 'specificUser', targetUserId: req.user.id }
            ],
            $or: [ // Considerar notificações sem data de expiração ou que ainda não expiraram
                { expiresAt: { $exists: false } },
                { expiresAt: null },
                { expiresAt: { $gt: now } }
            ]
        }).sort({ createdAt: -1 }).limit(5)
        .select('title message type createdAt');

        res.json({
            name: user.name,
            email: user.email,
            referralCode: `${FRONTEND_URL}/register.html?ref=${user.referralCode}`, // Link completo de referência
            totalBalance: parseFloat(totalBalance.toFixed(2)),
            mainBalanceMT: parseFloat((user.balance.MT || 0).toFixed(2)),
            bonusBalance: parseFloat((user.bonusBalance || 0).toFixed(2)),
            referralEarningsBalance: parseFloat((user.referralEarnings || 0).toFixed(2)),
            activeInvestments: activeInvestmentsDetails,
            claimHistory: claimHistoryDetails,
            deposits: deposits,
            referrals: {
                count: referralsMade.length,
                successfulCount: successfulReferrals,
                totalEarned: parseFloat((user.referralEarnings || 0).toFixed(2)),
                link: `${FRONTEND_URL}/register.html?ref=${user.referralCode}`
            },
            notifications: userNotifications,
            firstDepositMade: user.firstDepositMade,
            isBlocked: user.isBlocked
        });

    } catch (error) {
        console.error("Erro ao buscar dados do dashboard:", error);
        res.status(500).json({ message: "Erro ao buscar dados do painel." });
    }
});

// 9.2. Solicitar Depósito (POST /api/user/deposits)
userRouter.post('/deposits', async (req, res) => {
    const { amount, method, transactionIdOrConfirmationMessage, paymentDetailsUsed, planId } = req.body; // planId é opcional

    if (!amount || !method || !transactionIdOrConfirmationMessage || !paymentDetailsUsed) {
        return res.status(400).json({ message: "Valor, método, mensagem de confirmação e detalhes do pagamento são obrigatórios." });
    }
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ message: "Valor do depósito inválido." });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "Usuário não encontrado." });

        // Verificar se o método de pagamento é válido (pegando das config do admin)
        const siteConfig = await getSiteSettings();
        const activePaymentMethods = siteConfig.paymentMethods || []; // Vem do AdminSetting
        const choosenMethodConfig = activePaymentMethods.find(pm => pm.name === method && pm.isActive);

        if (!choosenMethodConfig) {
            return res.status(400).json({ message: `Método de pagamento '${method}' não está ativo ou não existe.` });
        }
        // Poderia verificar se `paymentDetailsUsed` corresponde ao `choosenMethodConfig.details`
        // Mas como o usuário seleciona e depois vê, pode ser o mesmo.

        const deposit = new Deposit({
            userId: req.user.id,
            amount: parseFloat(amount),
            method,
            transactionIdOrConfirmationMessage,
            paymentDetailsUsed, // O número/carteira que o admin configurou e o usuário usou
            status: 'Pendente'
            // planId pode ser associado aqui se o depósito for diretamente para um plano
        });
        await deposit.save();

        // Se um planId foi fornecido E o depósito for para um plano específico
        // A lógica de ativar o plano ocorreria APÓS a confirmação do depósito pelo admin.
        // Aqui apenas registramos a intenção se o frontend enviar.

        res.status(201).json({ message: "Solicitação de depósito recebida. Aguardando confirmação do administrador.", deposit });

    } catch (error) {
        console.error("Erro ao solicitar depósito:", error);
        res.status(500).json({ message: "Erro ao processar solicitação de depósito." });
    }
});

// 9.3. Listar Depósitos do Usuário (GET /api/user/deposits)
userRouter.get('/deposits', async (req, res) => {
    try {
        const deposits = await Deposit.find({ userId: req.user.id }).sort({ requestedAt: -1 });
        res.json(deposits);
    } catch (error) {
        console.error("Erro ao buscar depósitos:", error);
        res.status(500).json({ message: "Erro ao buscar histórico de depósitos." });
    }
});

// 9.4. Obter Métodos de Depósito Ativos (GET /api/user/deposit-methods)
userRouter.get('/deposit-methods', async (req, res) => {
    try {
        const siteConfig = await getSiteSettings();
        const paymentMethods = (siteConfig.paymentMethods || [])
            .filter(pm => pm.isActive)
            .map(pm => ({ name: pm.name, details: pm.details, instructions: pm.instructions, type: pm.type }));
        res.json(paymentMethods);
    } catch (error) {
        console.error("Erro ao buscar métodos de depósito:", error);
        res.status(500).json({ message: "Erro ao buscar métodos de depósito." });
    }
});


// 9.5. Realizar Claim (POST /api/user/claims)
userRouter.post('/claims', async (req, res) => {
    const { investmentId, currencyForClaim } = req.body; // investmentId é o _id do subdocumento activeInvestments
                                                        // currencyForClaim é a moeda escolhida pelo usuário para ESTE claim (ex: MT, BTC, ETH)

    if (!investmentId || !currencyForClaim) {
        return res.status(400).json({ message: "ID do investimento e moeda do claim são obrigatórios." });
    }

    // Validar se a moeda é permitida (pode vir de uma config global ou do plano)
    const allowedClaimCurrencies = ["MT", "BTC", "ETH", "USDT"]; // Simplificado, poderia ser configurável
    if (!allowedClaimCurrencies.includes(currencyForClaim.toUpperCase())) {
        return res.status(400).json({ message: `Moeda de claim '${currencyForClaim}' não é permitida.` });
    }

    try {
        const user = await User.findById(req.user.id).populate('activeInvestments.planId');
        if (!user) return res.status(404).json({ message: "Usuário não encontrado." });

        const investment = user.activeInvestments.id(investmentId);
        if (!investment) {
            return res.status(404).json({ message: "Investimento ativo não encontrado." });
        }
        if (!investment.planId) { // Checagem de segurança
            return res.status(500).json({ message: "Dados do plano associado ao investimento corrompidos."});
        }

        // Resetar claimsMadeToday se for um novo dia
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (investment.lastClaimDate && investment.lastClaimDate < today) {
            investment.claimsMadeToday = 0;
        }

        if (investment.claimsMadeToday >= (investment.planId.claimsPerDay || 5) ) {
            return res.status(400).json({ message: "Você já realizou o número máximo de claims para este investimento hoje." });
        }

        const claimAmountMT = investment.claimValue; // Valor do claim é sempre em MT (referência)

        // Adicionar ao saldo principal do usuário (MT)
        user.balance.MT = (user.balance.MT || 0) + claimAmountMT;

        investment.claimsMadeToday += 1;
        investment.lastClaimDate = new Date();

        const newClaimRecord = {
            planId: investment.planId._id,
            planName: investment.planName,
            claimNumber: investment.claimsMadeToday,
            amount: claimAmountMT,
            currency: currencyForClaim.toUpperCase(), // Moeda que o usuário "escolheu" para representar esse claim
            claimedAt: new Date()
        };
        user.claimHistory.push(newClaimRecord);

        await user.save();

        res.json({
            message: `Claim de ${claimAmountMT.toFixed(2)} MT (representado como ${currencyForClaim.toUpperCase()}) realizado com sucesso!`,
            claim: newClaimRecord,
            updatedBalanceMT: user.balance.MT,
            claimsMadeToday: investment.claimsMadeToday,
        });

    } catch (error) {
        console.error("Erro ao realizar claim:", error);
        res.status(500).json({ message: "Erro ao processar claim." });
    }
});


// 9.6. Listar Histórico de Claims do Usuário (GET /api/user/claims)
userRouter.get('/claims', async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('claimHistory').lean(); // .lean() para objeto JS puro
        if (!user) return res.status(404).json({ message: "Usuário não encontrado." });

        const claimHistory = (user.claimHistory || [])
            .sort((a, b) => b.claimedAt - a.claimedAt); // Mais recentes primeiro

        res.json(claimHistory);
    } catch (error) {
        console.error("Erro ao buscar histórico de claims:", error);
        res.status(500).json({ message: "Erro ao buscar histórico de claims." });
    }
});

// 9.7. Solicitar Saque (POST /api/user/withdrawals)
userRouter.post('/withdrawals', async (req, res) => {
    const { amount, withdrawalMethod, recipientInfo } = req.body;

    if (!amount || !withdrawalMethod || !recipientInfo) {
        return res.status(400).json({ message: "Valor, método de saque e informações do destinatário são obrigatórios." });
    }

    const withdrawalAmount = parseFloat(amount);
    if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
        return res.status(400).json({ message: "Valor de saque inválido." });
    }

    const MIN_WITHDRAWAL = 50; // Saque mínimo
    const MAX_WITHDRAWAL = 50000; // Saque máximo

    if (withdrawalAmount < MIN_WITHDRAWAL) {
        return res.status(400).json({ message: `O valor mínimo para saque é de ${MIN_WITHDRAWAL} MT.` });
    }
    if (withdrawalAmount > MAX_WITHDRAWAL) {
        return res.status(400).json({ message: `O valor máximo para saque é de ${MAX_WITHDRAWAL} MT.` });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "Usuário não encontrado." });

        if (!user.firstDepositMade) {
            return res.status(403).json({ message: "Você precisa realizar pelo menos um depósito confirmado para solicitar saques. Saldos de bônus e referências serão liberados após o primeiro depósito." });
        }

        // Calcular taxa de manuseio (exemplo simples, pode ser mais complexo)
        let feePercentage = 0.02; // 2% base
        if (withdrawalAmount > 10000) feePercentage = 0.05; // 5% para valores altos
        if (withdrawalAmount > 25000) feePercentage = 0.10; // 10%
        if (withdrawalMethod.toLowerCase().includes('btc') || withdrawalMethod.toLowerCase().includes('eth')) {
            feePercentage += 0.02; // Taxa adicional para cripto
        }
        feePercentage = Math.min(feePercentage, 0.15); // Máximo de 15%

        const feeApplied = parseFloat((withdrawalAmount * feePercentage).toFixed(2));
        const netAmount = parseFloat((withdrawalAmount - feeApplied).toFixed(2));

        // Verificar saldo disponível (saldo principal MT + bônus + referências)
        // Somente se o primeiro depósito já foi feito, o bônus e referência podem ser sacados.
        const availableBalanceForWithdrawal = (user.balance.MT || 0) + (user.bonusBalance || 0) + (user.referralEarnings || 0);

        if (withdrawalAmount > availableBalanceForWithdrawal) {
            return res.status(400).json({ message: `Saldo insuficiente para este saque. Saldo disponível para saque: ${availableBalanceForWithdrawal.toFixed(2)} MT.` });
        }

        // Deduzir o valor do saque dos saldos (priorizar saldo principal, depois bônus, depois referências)
        let amountToDeduct = withdrawalAmount;
        
        const mainBalanceDeduction = Math.min(amountToDeduct, user.balance.MT || 0);
        user.balance.MT -= mainBalanceDeduction;
        amountToDeduct -= mainBalanceDeduction;

        if (amountToDeduct > 0) {
            const bonusBalanceDeduction = Math.min(amountToDeduct, user.bonusBalance || 0);
            user.bonusBalance -= bonusBalanceDeduction;
            amountToDeduct -= bonusBalanceDeduction;
        }

        if (amountToDeduct > 0) {
            const referralEarningsDeduction = Math.min(amountToDeduct, user.referralEarnings || 0);
            user.referralEarnings -= referralEarningsDeduction;
            // amountToDeduct -= referralEarningsDeduction; // Não precisa mais
        }
        
        await user.save();

        const withdrawal = new Withdrawal({
            userId: req.user.id,
            amount: withdrawalAmount,
            withdrawalMethod,
            recipientInfo,
            feeApplied,
            netAmount,
            status: 'Pendente'
        });
        await withdrawal.save();

        res.status(201).json({
            message: `Solicitação de saque de ${withdrawalAmount.toFixed(2)} MT enviada. Taxa: ${feeApplied.toFixed(2)} MT. Valor líquido: ${netAmount.toFixed(2)} MT. Aguardando processamento.`,
            withdrawal
        });

    } catch (error) {
        console.error("Erro ao solicitar saque:", error);
        res.status(500).json({ message: "Erro ao processar solicitação de saque." });
    }
});

// 9.8. Listar Saques do Usuário (GET /api/user/withdrawals)
userRouter.get('/withdrawals', async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find({ userId: req.user.id }).sort({ requestedAt: -1 });
        res.json(withdrawals);
    } catch (error) {
        console.error("Erro ao buscar saques:", error);
        res.status(500).json({ message: "Erro ao buscar histórico de saques." });
    }
});


// 9.9. Informações de Referência do Usuário (GET /api/user/referrals)
userRouter.get('/referrals', async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('referralCode referralEarnings');
        if (!user) return res.status(404).json({ message: "Usuário não encontrado." });

        const referrals = await ReferralHistory.find({ referrerId: req.user.id })
            .populate('referredId', 'name email createdAt') // Popula dados do indicado
            .sort({ earnedAt: -1, _id: -1 });

        res.json({
            referralLink: `${FRONTEND_URL}/register.html?ref=${user.referralCode}`,
            totalEarned: user.referralEarnings || 0,
            referralsList: referrals.map(r => ({
                referredUserName: r.referredId ? r.referredId.name : 'Usuário Deletado',
                referredUserEmail: r.referredId ? r.referredId.email : '-',
                status: r.status,
                bonusAmount: r.bonusAmount,
                earnedAt: r.status === 'Confirmado' ? r.earnedAt : null,
                registeredAt: r.referredId ? r.referredId.createdAt : null,
            }))
        });
    } catch (error) {
        console.error("Erro ao buscar dados de referência:", error);
        res.status(500).json({ message: "Erro ao buscar dados de referência." });
    }
});


app.use('/api/user', userRouter);


// -----------------------------------------------------------------------------
// PLACEHOLDER PARA ROTAS DO ADMIN (virão na próxima parte)
// -----------------------------------------------------------------------------
// const adminRouter = express.Router();
// adminRouter.use(authenticateToken, authorizeAdmin);
// ...
// app.use('/api/admin', adminRouter);

// ... (resto do server.js, incluindo app.listen)
// server.js
// ... (todo o código da Parte 1, 2 e 3) ...

// -----------------------------------------------------------------------------
// 10. ROTAS DO ADMINISTRADOR
// -----------------------------------------------------------------------------
const adminRouter = express.Router();
adminRouter.use(authenticateToken, authorizeAdmin); // Todas as rotas aqui são protegidas e para admin

// 10.1. Gerenciamento de Depósitos
// 10.1.1. Listar todos os depósitos (com filtros) (GET /api/admin/deposits)
adminRouter.get('/deposits', async (req, res) => {
    const { status, userId, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (userId) query.userId = userId;

    try {
        const deposits = await Deposit.find(query)
            .populate('userId', 'name email') // Adiciona nome e email do usuário
            .sort({ requestedAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        const totalDeposits = await Deposit.countDocuments(query);

        res.json({
            deposits,
            totalPages: Math.ceil(totalDeposits / limit),
            currentPage: parseInt(page),
            totalCount: totalDeposits
        });
    } catch (error) {
        console.error("Admin - Erro ao listar depósitos:", error);
        res.status(500).json({ message: "Erro ao listar depósitos." });
    }
});
// EM server.js (dentro de adminRouter)

// 10.4.6. Ajustar Saldo do Usuário (PATCH /api/admin/users/:userId/adjust-balance)
adminRouter.patch('/users/:userId/adjust-balance', async (req, res) => {
    const { userId } = req.params;
    const { amount, balanceType, reason, operation = 'subtract' } = req.body; // balanceType: 'MT', 'bonusBalance', 'referralEarnings'
                                                                      // operation: 'add' ou 'subtract'

    if (!amount || typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ message: "Valor (amount) inválido ou não fornecido." });
    }
    if (!balanceType || !['MT', 'bonusBalance', 'referralEarnings'].includes(balanceType)) {
        return res.status(400).json({ message: "Tipo de saldo (balanceType) inválido." });
    }
    if (!reason || reason.trim() === '') {
        return res.status(400).json({ message: "Motivo (reason) é obrigatório para o ajuste." });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "Usuário não encontrado." });
        }

        let originalValue;

        if (balanceType === 'MT') {
            originalValue = user.balance.MT || 0;
            if (operation === 'subtract') {
                if (originalValue < amount) return res.status(400).json({ message: `Saldo MT insuficiente (${originalValue.toFixed(2)}) para remover ${amount.toFixed(2)}.` });
                user.balance.MT -= amount;
            } else {
                user.balance.MT += amount;
            }
        } else if (balanceType === 'bonusBalance') {
            originalValue = user.bonusBalance || 0;
            if (operation === 'subtract') {
                if (originalValue < amount) return res.status(400).json({ message: `Saldo de Bônus insuficiente (${originalValue.toFixed(2)}) para remover ${amount.toFixed(2)}.` });
                user.bonusBalance -= amount;
            } else {
                user.bonusBalance += amount;
            }
        } else if (balanceType === 'referralEarnings') {
            originalValue = user.referralEarnings || 0;
            if (operation === 'subtract') {
                if (originalValue < amount) return res.status(400).json({ message: `Saldo de Ganhos de Referência insuficiente (${originalValue.toFixed(2)}) para remover ${amount.toFixed(2)}.` });
                user.referralEarnings -= amount;
            } else {
                user.referralEarnings += amount;
            }
        }

        // Opcional: Registrar essa transação administrativa em um log/histórico
        // Ex: const adminLog = new AdminActionLog({ adminId: req.user.id, targetUserId: userId, action: 'adjust_balance', details: { amount, balanceType, reason, operation, originalValue, newValue: user[balanceType] || user.balance.MT }});
        // await adminLog.save();

        await user.save();
        res.json({
            message: `Saldo ${balanceType} do usuário ${user.name} ${operation === 'subtract' ? 'reduzido' : 'aumentado'} em ${amount.toFixed(2)} MT. Motivo: ${reason}`,
            user: { // Retornar os saldos atualizados
                _id: user._id,
                name: user.name,
                balance: user.balance,
                bonusBalance: user.bonusBalance,
                referralEarnings: user.referralEarnings
            }
        });

    } catch (error) {
        console.error("Admin - Erro ao ajustar saldo do usuário:", error);
        res.status(500).json({ message: "Erro interno ao ajustar saldo." });
    }
});

// 10.1.2. Aprovar ou Rejeitar Depósito (PATCH /api/admin/deposits/:depositId)
adminRouter.patch('/deposits/:depositId', async (req, res) => {
    const { depositId } = req.params;
    const { status, adminNotes } = req.body; // status deve ser 'Confirmado' ou 'Rejeitado'

    if (!['Confirmado', 'Rejeitado'].includes(status)) {
        return res.status(400).json({ message: "Status inválido. Use 'Confirmado' ou 'Rejeitado'." });
    }

    try {
        const deposit = await Deposit.findById(depositId);
        if (!deposit) {
            return res.status(404).json({ message: "Depósito não encontrado." });
        }
        if (deposit.status !== 'Pendente') {
            return res.status(400).json({ message: `Este depósito já foi ${deposit.status.toLowerCase()}.` });
        }

        const user = await User.findById(deposit.userId);
        if (!user) {
            return res.status(404).json({ message: "Usuário associado ao depósito não encontrado." });
        }

        deposit.status = status;
        deposit.processedAt = new Date();
        if (adminNotes) deposit.adminNotes = adminNotes; // Se houver notas do admin

        if (status === 'Confirmado') {
            // Adicionar valor ao saldo principal do usuário (MT)
            user.balance.MT = (user.balance.MT || 0) + deposit.amount;

            // Verificar se é o primeiro depósito confirmado do usuário
            if (!user.firstDepositMade) {
                user.firstDepositMade = true;
                // (O bônus de cadastro já foi dado no bonusBalance, agora ele se torna "sacável")

                // Liberar bônus de referência para quem o indicou
                const referralRecord = await ReferralHistory.findOne({ referredId: user._id, status: 'Pendente' });
                if (referralRecord) {
                    const referrer = await User.findById(referralRecord.referrerId);
                    if (referrer) {
                        referrer.referralEarnings = (referrer.referralEarnings || 0) + referralRecord.bonusAmount;
                        referralRecord.status = 'Confirmado';
                        referralRecord.earnedAt = new Date();
                        await referrer.save();
                        await referralRecord.save();
                        // TODO: Notificar referrer sobre o bônus ganho (opcional)
                        console.log(`Bônus de referência de ${referralRecord.bonusAmount} MT creditado para ${referrer.email}`);
                    }
                }
            }

            // Lógica de atribuição de plano se o depósito foi para um plano
            // O frontend deve ter enviado planId na criação do depósito se aplicável,
            // mas a ativação do plano é feita AQUI, após confirmação.
            // Se o depósito foi apenas para "adicionar saldo", essa parte é pulada.
            // Vamos assumir que o frontend envia um `targetPlanId` se o depósito é para um plano específico.
            const { targetPlanId } = req.body; // Admin pode confirmar para qual plano é, ou o sistema pode ter guardado.
                                                // Se não vier, o depósito apenas aumenta o saldo.

            if (targetPlanId) {
                 const planToActivate = await Plan.findById(targetPlanId);
                 if (planToActivate && planToActivate.isActive && deposit.amount >= planToActivate.investmentAmount) {
                    // Remover valor do plano do saldo (já que foi adicionado acima)
                    // user.balance.MT -= planToActivate.investmentAmount; // Não precisa, se o plano consome o depósito

                    const newInvestment = {
                        planId: planToActivate._id,
                        planName: planToActivate.name,
                        investedAmount: planToActivate.investmentAmount, // ou deposit.amount se for o caso
                        dailyProfitRate: planToActivate.dailyProfitRate,
                        dailyProfitAmount: planToActivate.dailyProfitAmount,
                        claimValue: planToActivate.claimValue,
                        claimsMadeToday: 0,
                        activatedAt: new Date(),
                    };
                    user.activeInvestments.push(newInvestment);
                    console.log(`Plano ${planToActivate.name} ativado para ${user.email} com depósito de ${deposit.amount} MT.`);
                 } else {
                    console.warn(`Admin: Plano ${targetPlanId} não encontrado, inativo ou valor do depósito insuficiente para ativação. Depósito apenas aumentou o saldo.`);
                    // Poderia adicionar uma nota ao depósito ou uma notificação ao usuário.
                 }
            }
            await user.save();
        }
        // Se rejeitado, o saldo do usuário não muda. O valor nunca entrou.

        await deposit.save();
        // TODO: Enviar notificação ao usuário sobre o status do depósito (opcional)

        res.json({ message: `Depósito ${status.toLowerCase()} com sucesso.`, deposit });

    } catch (error) {
        console.error(`Admin - Erro ao ${status === 'Confirmado' ? 'aprovar' : 'rejeitar'} depósito:`, error);
        res.status(500).json({ message: "Erro ao processar o depósito." });
    }
});


// 10.2. Gerenciamento de Métodos de Pagamento (AdminSetting)
// 10.2.1. Listar métodos de pagamento (GET /api/admin/payment-methods)
adminRouter.get('/payment-methods', async (req, res) => {
    try {
        const setting = await AdminSetting.findOne({ key: 'paymentMethods' });
        const methods = setting && setting.value ? setting.value : [];
        res.json(methods);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar métodos de pagamento.', error: error.message });
    }
});

// 10.2.2. Adicionar/Atualizar método de pagamento (POST /api/admin/payment-methods)
// Isso irá substituir todos os métodos existentes. Para adicionar um, o admin deve reenviar a lista completa.
// Ou podemos fazer rotas separadas para adicionar/editar/remover um específico.
// Por simplicidade, vamos substituir a lista inteira.
adminRouter.post('/payment-methods', async (req, res) => {
    const { methods } = req.body; // Espera um array de objetos paymentMethodSchema
    if (!Array.isArray(methods)) {
        return res.status(400).json({ message: 'Formato inválido. "methods" deve ser um array.' });
    }
    // Validação de cada método (simples)
    for (const method of methods) {
        if (!method.name || !method.details || !method.type) {
            return res.status(400).json({ message: 'Cada método deve ter nome, detalhes e tipo (fiat/crypto).' });
        }
    }

    try {
        await AdminSetting.findOneAndUpdate(
            { key: 'paymentMethods' },
            { key: 'paymentMethods', value: methods, description: 'Lista de métodos de pagamento para depósito.' },
            { upsert: true, new: true }
        );
        siteSettingsCache = null; // Invalidar cache
        await getSiteSettings(); // Recarregar cache
        res.json({ message: 'Métodos de pagamento atualizados com sucesso.', methods });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao atualizar métodos de pagamento.', error: error.message });
    }
});

// 10.3. Gerenciamento de Planos de Investimento
// 10.3.1. Listar todos os planos (GET /api/admin/plans)
adminRouter.get('/plans', async (req, res) => {
    try {
        const plans = await Plan.find({}).sort({ order: 1, investmentAmount: 1 });
        res.json(plans);
    } catch (error) {
        res.status(500).json({ message: "Erro ao buscar planos." });
    }
});

// 10.3.2. Criar Plano (POST /api/admin/plans)
adminRouter.post('/plans', async (req, res) => {
    const { name, investmentAmount, dailyProfitRate, dailyProfitAmount, claimValue, claimsPerDay = 5, isActive = true, order = 0 } = req.body;
    try {
        const newPlan = new Plan({ name, investmentAmount, dailyProfitRate, dailyProfitAmount, claimValue, claimsPerDay, isActive, order });
        await newPlan.save();
        res.status(201).json({ message: "Plano criado com sucesso.", plan: newPlan });
    } catch (error)
    {
        if (error.code === 11000) { // Erro de duplicidade
            return res.status(409).json({ message: "Erro: Já existe um plano com este nome ou valor de investimento.", details: error.keyValue });
        }
        console.error("Admin - Erro ao criar plano:", error);
        res.status(500).json({ message: "Erro ao criar plano." });
    }
});

// 10.3.3. Editar Plano (PUT /api/admin/plans/:planId)
adminRouter.put('/plans/:planId', async (req, res) => {
    const { planId } = req.params;
    const { name, investmentAmount, dailyProfitRate, dailyProfitAmount, claimValue, claimsPerDay, isActive, order } = req.body;
    try {
        const plan = await Plan.findByIdAndUpdate(planId,
            { name, investmentAmount, dailyProfitRate, dailyProfitAmount, claimValue, claimsPerDay, isActive, order },
            { new: true, runValidators: true } // new:true retorna o documento atualizado, runValidators:true aplica validações do schema
        );
        if (!plan) return res.status(404).json({ message: "Plano não encontrado." });
        res.json({ message: "Plano atualizado com sucesso.", plan });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ message: "Erro: Já existe outro plano com este nome ou valor de investimento.", details: error.keyValue });
        }
        console.error("Admin - Erro ao atualizar plano:", error);
        res.status(500).json({ message: "Erro ao atualizar plano." });
    }
});

// 10.3.4. Deletar Plano (DELETE /api/admin/plans/:planId)
adminRouter.delete('/plans/:planId', async (req, res) => {
    const { planId } = req.params;
    try {
        // Verificar se o plano está em uso por algum usuário (em activeInvestments)
        const usersWithPlan = await User.countDocuments({ "activeInvestments.planId": planId });
        if (usersWithPlan > 0) {
            return res.status(400).json({ message: `Não é possível deletar o plano. Ele está ativo para ${usersWithPlan} usuário(s). Considere desativá-lo.` });
        }
        const plan = await Plan.findByIdAndDelete(planId);
        if (!plan) return res.status(404).json({ message: "Plano não encontrado." });
        res.json({ message: "Plano deletado com sucesso." });
    } catch (error) {
        console.error("Admin - Erro ao deletar plano:", error);
        res.status(500).json({ message: "Erro ao deletar plano." });
    }
});


// 10.4. Gerenciamento de Usuários
// 10.4.1. Listar usuários (GET /api/admin/users)
adminRouter.get('/users', async (req, res) => {
    const { page = 1, limit = 10, search = '', isBlocked } = req.query;
    const query = {};
    if (search) {
        query.$or = [
            { name: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
            { referralCode: { $regex: search, $options: 'i' } }
        ];
    }
    if (typeof isBlocked !== 'undefined' && (isBlocked === 'true' || isBlocked === 'false')) {
        query.isBlocked = isBlocked === 'true';
    }

    try {
        const users = await User.find(query)
            .select('-password -securityAnswer -securityQuestion -claimHistory') // Excluir campos sensíveis/grandes
            .populate('referredBy', 'name email')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        const totalUsers = await User.countDocuments(query);
        res.json({
            users,
            totalPages: Math.ceil(totalUsers / limit),
            currentPage: parseInt(page),
            totalCount: totalUsers
        });
    } catch (error) {
        console.error("Admin - Erro ao listar usuários:", error);
        res.status(500).json({ message: "Erro ao listar usuários." });
    }
});

// 10.4.2. Ver detalhes de um usuário (GET /api/admin/users/:userId)
adminRouter.get('/users/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId)
            .select('-password -securityAnswer') // Deixa a securityQuestion para o admin poder perguntar
            .populate('activeInvestments.planId', 'name investmentAmount')
            .populate({
                path: 'referredBy',
                select: 'name email'
            })
            .populate({
                path: 'claimHistory',
                options: { sort: { claimedAt: -1 }, limit: 20 } // Limita histórico de claims
            });

        if (!user) return res.status(404).json({ message: "Usuário não encontrado." });

        const deposits = await Deposit.find({ userId: user._id }).sort({ requestedAt: -1 }).limit(10);
        const withdrawals = await Withdrawal.find({ userId: user._id }).sort({ requestedAt: -1 }).limit(10);
        const referrals = await ReferralHistory.find({ referrerId: user._id }).populate('referredId', 'name email');

        res.json({ user, deposits, withdrawals, referrals });
    } catch (error) {
        console.error("Admin - Erro ao buscar detalhes do usuário:", error);
        res.status(500).json({ message: "Erro ao buscar detalhes do usuário." });
    }
});


// 10.4.3. Bloquear/Desbloquear Usuário (PATCH /api/admin/users/:userId/block)
adminRouter.patch('/users/:userId/block', async (req, res) => {
    const { block } = req.body; // true para bloquear, false para desbloquear
    if (typeof block !== 'boolean') {
        return res.status(400).json({ message: "O status de bloqueio (block) deve ser true ou false." });
    }
    try {
        const user = await User.findByIdAndUpdate(req.params.userId, { isBlocked: block }, { new: true })
            .select('name email isBlocked');
        if (!user) return res.status(404).json({ message: "Usuário não encontrado." });
        res.json({ message: `Usuário ${user.name} ${block ? 'bloqueado' : 'desbloqueado'} com sucesso.`, user });
    } catch (error) {
        console.error("Admin - Erro ao bloquear/desbloquear usuário:", error);
        res.status(500).json({ message: "Erro ao atualizar status de bloqueio do usuário." });
    }
});

// 10.4.4. Forçar Atribuição de Plano para Usuário (POST /api/admin/users/:userId/assign-plan)
adminRouter.post('/users/:userId/assign-plan', async (req, res) => {
    const { userId } = req.params;
    const { planId } = req.body;

    if (!planId) {
        return res.status(400).json({ message: "ID do plano (planId) é obrigatório." });
    }

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "Usuário não encontrado." });

        const planToAssign = await Plan.findById(planId);
        if (!planToAssign || !planToAssign.isActive) {
            return res.status(404).json({ message: "Plano não encontrado ou está inativo." });
        }

        // Verificar se o usuário já tem este plano ativo (opcional, pode permitir múltiplos do mesmo plano)
        // const existingInvestment = user.activeInvestments.find(inv => inv.planId.toString() === planId);
        // if (existingInvestment) {
        //     return res.status(400).json({ message: `Usuário já possui o plano ${planToAssign.name} ativo.` });
        // }

        const newInvestment = {
            planId: planToAssign._id,
            planName: planToAssign.name,
            investedAmount: planToAssign.investmentAmount,
            dailyProfitRate: planToAssign.dailyProfitRate,
            dailyProfitAmount: planToAssign.dailyProfitAmount,
            claimValue: planToAssign.claimValue,
            claimsMadeToday: 0,
            activatedAt: new Date(),
        };
        user.activeInvestments.push(newInvestment);
        await user.save();

        res.json({ message: `Plano ${planToAssign.name} atribuído com sucesso ao usuário ${user.name}.`, investment: newInvestment });

    } catch (error) {
        console.error("Admin - Erro ao atribuir plano:", error);
        res.status(500).json({ message: "Erro ao atribuir plano ao usuário." });
    }
});

// 10.4.5. (Admin) Recuperar conta do usuário (verificando pergunta de segurança)
// Esta rota seria para o admin confirmar a resposta de segurança e talvez resetar a senha.
// Apenas um exemplo de como o admin pode verificar a resposta.
adminRouter.post('/users/:userId/verify-security-answer', async (req, res) => {
    const { userId } = req.params;
    const { answer } = req.body;

    if (!answer) {
        return res.status(400).json({ message: "Resposta de segurança é obrigatória." });
    }

    try {
        const user = await User.findById(userId).select('+securityAnswer +securityQuestion'); // precisa buscar a resposta hasheada
        if (!user) {
            return res.status(404).json({ message: "Usuário não encontrado." });
        }
        if (!user.securityAnswer || !user.securityQuestion) {
            return res.status(400).json({ message: "Usuário não configurou pergunta/resposta de segurança." });
        }

        const isMatch = await bcrypt.compare(answer, user.securityAnswer);
        if (!isMatch) {
            return res.status(400).json({ message: "Resposta de segurança incorreta." });
        }

        // Se a resposta estiver correta, o admin pode proceder com a recuperação (ex: reset de senha).
        // Aqui, apenas confirmamos. O frontend do admin pode então oferecer a opção de resetar a senha.
        res.json({
            message: "Resposta de segurança verificada com sucesso.",
            securityQuestion: user.securityQuestion
            // Poderia retornar um token de curta duração para permitir o reset da senha.
        });

    } catch (error) {
        console.error("Admin - Erro ao verificar resposta de segurança:", error);
        res.status(500).json({ message: "Erro ao verificar resposta de segurança." });
    }
});


// 10.5. Gerenciamento de Saques
// 10.5.1. Listar todos os saques (com filtros) (GET /api/admin/withdrawals)
adminRouter.get('/withdrawals', async (req, res) => {
    const { status, userId, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (userId) query.userId = userId;

    try {
        const withdrawals = await Withdrawal.find(query)
            .populate('userId', 'name email')
            .sort({ requestedAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        const totalWithdrawals = await Withdrawal.countDocuments(query);

        res.json({
            withdrawals,
            totalPages: Math.ceil(totalWithdrawals / limit),
            currentPage: parseInt(page),
            totalCount: totalWithdrawals
        });
    } catch (error) {
        console.error("Admin - Erro ao listar saques:", error);
        res.status(500).json({ message: "Erro ao listar saques." });
    }
});

// 10.5.2. Processar (Aprovar/Rejeitar) Saque (PATCH /api/admin/withdrawals/:withdrawalId)
adminRouter.patch('/withdrawals/:withdrawalId', async (req, res) => {
    const { withdrawalId } = req.params;
    const { status, adminNotes } = req.body; // status: 'Processado' ou 'Rejeitado'

    if (!['Processado', 'Rejeitado'].includes(status)) {
        return res.status(400).json({ message: "Status inválido. Use 'Processado' ou 'Rejeitado'." });
    }

    try {
        const withdrawal = await Withdrawal.findById(withdrawalId);
        if (!withdrawal) {
            return res.status(404).json({ message: "Solicitação de saque não encontrada." });
        }
        if (withdrawal.status !== 'Pendente') {
            return res.status(400).json({ message: `Este saque já foi ${withdrawal.status.toLowerCase()}.` });
        }

        withdrawal.status = status;
        withdrawal.processedAt = new Date();
        if (adminNotes) withdrawal.adminNotes = adminNotes;

        if (status === 'Rejeitado') {
            // Devolver o valor ao saldo do usuário
            const user = await User.findById(withdrawal.userId);
            if (user) {
                // O valor foi deduzido na solicitação. Agora devolvemos o valor total solicitado (antes da taxa).
                // A ordem de devolução pode ser flexível, mas vamos tentar repor na mesma lógica de dedução.
                let amountToReturn = withdrawal.amount;

                // Quanto foi deduzido de cada saldo? (Não temos essa info guardada, então é uma estimativa)
                // Por simplicidade, adicionamos tudo de volta ao saldo MT principal.
                // Idealmente, o sistema deveria rastrear de qual sub-saldo o valor foi debitado.
                user.balance.MT = (user.balance.MT || 0) + amountToReturn;
              // Alternativa mais complexa: se você souber as prioridades de dedução:
                // Supondo que bonusBalance e referralEarnings são os últimos a serem tocados:
                // user.referralEarnings += Math.min(amountToReturn, valor_original_deduzido_do_referral_se_souber);
                // amountToReturn -= Math.min(amountToReturn, valor_original_deduzido_do_referral_se_souber);
                // user.bonusBalance += Math.min(amountToReturn, valor_original_deduzido_do_bonus_se_souber);
                // amountToReturn -= Math.min(amountToReturn, valor_original_deduzido_do_bonus_se_souber);
                // user.balance.MT += amountToReturn;

                await user.save();
                console.log(`Admin: Saque ${withdrawalId} rejeitado. Valor ${withdrawal.amount} MT devolvido ao usuário ${user.email}.`);
            } else {
                console.error(`Admin: Usuário ${withdrawal.userId} do saque rejeitado não encontrado para devolução de saldo.`);
            }
        }
        // Se 'Processado', o dinheiro já foi "enviado" externamente. O saldo do usuário já foi debitado na solicitação.

        await withdrawal.save();
        // TODO: Notificar usuário sobre o status do saque (opcional)

        res.json({ message: `Saque ${status.toLowerCase()} com sucesso.`, withdrawal });

    } catch (error) {
        console.error(`Admin - Erro ao ${status === 'Processado' ? 'processar' : 'rejeitar'} saque:`, error);
        res.status(500).json({ message: "Erro ao processar o saque." });
    }
});

// 10.6. Gerenciamento de Configurações Gerais do Site (AdminSetting)
// 10.6.1. Listar todas as configurações (GET /api/admin/settings)
adminRouter.get('/settings', async (req, res) => {
    try {
        const settings = await AdminSetting.find({});
        // Transformar em um objeto chave-valor para o admin
        const formattedSettings = {};
        settings.forEach(s => formattedSettings[s.key] = { value: s.value, description: s.description });
        res.json(formattedSettings);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar configurações.', error: error.message });
    }
});

// 10.6.2. Atualizar/Criar uma configuração (POST /api/admin/settings)
adminRouter.post('/settings', async (req, res) => {
    const { key, value, description } = req.body;
    if (!key || typeof value === 'undefined') {
        return res.status(400).json({ message: 'Chave (key) e valor (value) são obrigatórios.' });
    }
  try {
        const setting = await AdminSetting.findOneAndUpdate(
            { key },
            { key, value, description },
            { upsert: true, new: true }
        );
        siteSettingsCache = null; // Invalidar cache
        await getSiteSettings(); // Recarregar cache
        res.json({ message: `Configuração '${key}' atualizada com sucesso.`, setting });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao atualizar configuração.', error: error.message });
    }
});

// 10.7. Gerenciamento de Notificações/Comunicados para Usuários
// 10.7.1. Criar Notificação (POST /api/admin/notifications)
adminRouter.post('/notifications', async (req, res) => {
    const { title, message, type, targetAudience = 'all', targetUserId, expiresAt } = req.body;
    if (!title || !message || !type) {
        return res.status(400).json({ message: "Título, mensagem e tipo são obrigatórios." });
    }
    if (targetAudience === 'specificUser' && !targetUserId) {
        return res.status(400).json({ message: "targetUserId é obrigatório para targetAudience 'specificUser'." });
    }
    try {
        const notification = new Notification({ title, message, type, targetAudience, targetUserId, isActive: true, expiresAt });
        await notification.save();
        res.status(201).json({ message: "Notificação criada com sucesso.", notification });
    } catch (error) {
        console.error("Admin - Erro ao criar notificação:", error);
        res.status(500).json({ message: "Erro ao criar notificação." });
    }
});

// 10.7.2. Listar Notificações (GET /api/admin/notifications)
adminRouter.get('/notifications', async (req, res) => {
    try {
        const notifications = await Notification.find({}).sort({ createdAt: -1 });
        res.json(notifications);
    } catch (error) {
        console.error("Admin - Erro ao listar notificações:", error);
        res.status(500).json({ message: "Erro ao listar notificações." });
    }
});
   // 10.7.3. Editar Notificação (PUT /api/admin/notifications/:notificationId)
adminRouter.put('/notifications/:notificationId', async (req, res) => {
    const { notificationId } = req.params;
    const { title, message, type, targetAudience, targetUserId, isActive, expiresAt } = req.body;
    try {
        const notification = await Notification.findByIdAndUpdate(notificationId,
            { title, message, type, targetAudience, targetUserId, isActive, expiresAt },
            { new: true }
        );
        if (!notification) return res.status(404).json({ message: "Notificação não encontrada." });
        res.json({ message: "Notificação atualizada com sucesso.", notification });
    } catch (error) {
        console.error("Admin - Erro ao atualizar notificação:", error);
        res.status(500).json({ message: "Erro ao atualizar notificação." });
    }
});

// 10.7.4. Deletar Notificação (DELETE /api/admin/notifications/:notificationId)
adminRouter.delete('/notifications/:notificationId', async (req, res) => {
    try {
        const notification = await Notification.findByIdAndDelete(req.params.notificationId);
        if (!notification) return res.status(404).json({ message: "Notificação não encontrada." });
        res.json({ message: "Notificação deletada com sucesso." });
    } catch (error) {
        console.error("Admin - Erro ao deletar notificação:", error);
        res.status(500).json({ message: "Erro ao deletar notificação." });
    }
});

// 10.8. Estatísticas Gerais e Dados Fictícios (para o admin ver)
adminRouter.get('/stats/overview', async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const activeUsers = await User.countDocuments({ lastLoginAt: { $gte: new Date(new Date() - 30 * 24 * 60 * 60 * 1000) } }); // Logados nos últimos 30 dias
        const totalDeposits = await Deposit.aggregate([
            { $match: { status: 'Confirmado' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalWithdrawals = await Withdrawal.aggregate([
            { $match: { status: 'Processado' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const pendingDepositsCount = await Deposit.countDocuments({ status: 'Pendente' });
        const pendingWithdrawalsCount = await Withdrawal.countDocuments({ status: 'Pendente' });

        // Dados dos planos
        const plans = await Plan.find({isActive: true}).select('name investmentAmount');
        const activeInvestmentsByPlan = {};
        for (const plan of plans) {
            activeInvestmentsByPlan[plan.name] = await User.countDocuments({'activeInvestments.planId': plan._id});
        }
      res.json({
            totalUsers,
            activeUsers,
            totalDeposited: totalDeposits.length > 0 ? totalDeposits[0].total : 0,
            totalWithdrawn: totalWithdrawals.length > 0 ? totalWithdrawals[0].total : 0,
            pendingDepositsCount,
            pendingWithdrawalsCount,
            activeInvestmentsByPlan,
            // Adicionar mais estatísticas conforme necessário
        });
    } catch (error) {
        console.error("Admin - Erro ao buscar estatísticas:", error);
        res.status(500).json({ message: "Erro ao buscar estatísticas." });
    }
});

// 10.9. Gerenciar Claims (Ver todos os claims, talvez filtrar por moeda)
adminRouter.get('/claims', async (req, res) => {
    const { userId, planId, currency, page = 1, limit = 20 } = req.query;
    let userQuery = {};

    // Se filtros forem fornecidos, precisamos buscar os usuários que correspondem
    // e depois extrair os claims deles. Isso pode ser complexo.
    // Uma abordagem mais simples é filtrar os claims diretamente se o `userId` for fornecido.
    // Se não, mostrar todos os claims de todos os usuários (paginado).

    try {
        if (userId) {
            const user = await User.findById(userId).select('claimHistory name email').populate('claimHistory.planId', 'name');
            if (!user) return res.status(404).json({ message: "Usuário não encontrado." });
            
            let claims = user.claimHistory;
            if(currency) claims = claims.filter(c => c.currency === currency.toUpperCase());
            if(planId) claims = claims.filter(c => c.planId && c.planId.toString() === planId);

            claims.sort((a, b) => b.claimedAt - a.claimedAt);
            const paginatedClaims = claims.slice((page - 1) * limit, page * limit);
            
            res.json({
                claims: paginatedClaims.map(c => ({ ...c, userName: user.name, userEmail: user.email })),
                totalPages: Math.ceil(claims.length / limit),
                currentPage: parseInt(page),
                totalCount: claims.length
            });
          } else {
            // Listar todos os claims de todos os usuários (pode ser pesado, usar com cautela ou agregação)
            // Por simplicidade, vamos buscar usuários e depois seus claims. Isso NÃO é ideal para performance em grande escala.
            // A melhor forma seria ter uma collection 'AllClaims' separada ou usar agregação no MongoDB.
            // Como os claims são subdocumentos, a query é mais complexa.
            // Exemplo simples (NÃO EFICIENTE PARA MUITOS USUÁRIOS/CLAIMS):
            const usersWithClaims = await User.find({ 'claimHistory.0': { $exists: true } })
                .select('name email claimHistory')
                .populate('claimHistory.planId', 'name')
                .sort({'claimHistory.claimedAt': -1}); // Não vai funcionar como esperado aqui.

            let allClaims = [];
            usersWithClaims.forEach(user => {
                user.claimHistory.forEach(claim => {
                    let passesFilter = true;
                    if (currency && claim.currency !== currency.toUpperCase()) passesFilter = false;
                    if (planId && claim.planId && claim.planId._id.toString() !== planId) passesFilter = false;

                    if(passesFilter) {
                        allClaims.push({
                            ...claim.toObject(), // Converter subdocumento para objeto
                            userId: user._id,
                            userName: user.name,
                            userEmail: user.email
                        });
                    }
                });
            });

            allClaims.sort((a, b) => new Date(b.claimedAt) - new Date(a.claimedAt)); // Ordenar após coletar

            const paginatedClaims = allClaims.slice((page - 1) * limit, page * limit);

            res.json({
                claims: paginatedClaims,
                totalPages: Math.ceil(allClaims.length / limit),
                currentPage: parseInt(page),
                totalCount: allClaims.length,
                note: "Listar todos os claims pode ser intensivo. Considere filtrar por usuário."
            });
        }

    } catch (error) {
        console.error("Admin - Erro ao listar claims:", error);
        res.status(500).json({ message: "Erro ao listar claims." });
    }
});
app.use('/api/admin', adminRouter);

// ... (resto do server.js, incluindo app.listen)
