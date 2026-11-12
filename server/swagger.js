const config = require('./config.json')

const swaggerAutogen = require('swagger-autogen')({
    openapi: '3.0.0'
});

const doc = {
    openapi: '3.0.0',

    info: {
        title: 'Nyaitter API',
        description: 'Nyaitter API For Dev',
        version: '1.0.0'
    },

    servers: [
        {
            url: 'http://localhost:3000',
            description: 'Development'
        },
        {
            url: config.federation.publicUrl,
            description: 'Production'
        }
    ]
};

const outputFile = './swagger-output.json';

// Expressのルート登録を解析
const endpointsFiles = ['./index.js'];

swaggerAutogen(outputFile, endpointsFiles, doc);