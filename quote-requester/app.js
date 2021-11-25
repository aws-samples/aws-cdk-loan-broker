const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const dynamodb = new DynamoDBClient({ apiVersion: "2012-08-10" });

const mortgageQuotesTable = process.env.MORTGAGE_QUOTES_TABLE;

exports.handler = async (event) => {
    console.info("Received event:", JSON.stringify(event, null, 4));
    var id = event["Id"];

    var getItemCommand = new GetItemCommand({
        TableName: mortgageQuotesTable,
        Key: { Id: { S: id } },
    });

    var getItemResponse = await dynamodb.send(getItemCommand);
    console.debug(JSON.stringify(getItemResponse));

    if (getItemResponse.Item) {
        console.debug(unmarshall(getItemResponse.Item));

        return unmarshall(getItemResponse.Item);
    } else {
        return { quotes: [] };
    }
};
