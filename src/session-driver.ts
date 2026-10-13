import { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

// Astro session driver backed by DynamoDB. The SDK signs with the Web Function's execution role
// and targets the Region it runs in, so with a global table each Region uses its local replica.
export default function dynamodbSessionDriver() {
	const db = new DynamoDBClient({});
	const TableName = process.env.SESSION_TABLE;
	return {
		async getItem(id: string) {
			const { Item } = await db.send(new GetItemCommand({ TableName, Key: { id: { S: id } } }));
			return Item?.value?.S ?? null;
		},
		async setItem(id: string, value: string) {
			await db.send(new PutItemCommand({ TableName, Item: { id: { S: id }, value: { S: value } } }));
		},
		async removeItem(id: string) {
			await db.send(new DeleteItemCommand({ TableName, Key: { id: { S: id } } }));
		},
	};
}
