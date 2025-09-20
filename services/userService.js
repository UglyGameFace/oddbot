 
import * as userRepository from '../repositories/userRepository.js';

export const findOrCreateUser = async (userInfo) => {
    try {
        let user = await userRepository.findUserById(userInfo.id);
        if (!user) {
            console.log(`User ${userInfo.id} not found. Creating...`);
            user = await userRepository.createUser(userInfo);
            console.log(`User ${userInfo.id} created successfully.`);
        }
        return user;
    } catch (error) {
        // In a real app, this would log to Sentry
        console.error(`Service Error: Could not find or create user ${userInfo.id}.`, error);
        throw new Error('Failed to process user data.');
    }
};
